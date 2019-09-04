import warning from 'warning';

import {
  getFragments,
  getMainOperation,
  getSelectionSet,
  normalizeVariables,
  getName,
  getFieldArguments,
  getFieldAlias,
} from '../ast';

import {
  Fragments,
  Variables,
  Data,
  DataField,
  Link,
  SelectionSet,
  OperationRequest,
  NullArray,
} from '../types';

import {
  Store,
  addDependency,
  getCurrentDependencies,
  initStoreState,
  clearStoreState,
} from '../store';

import { SelectionIterator, isScalar } from './shared';
import { joinKeys, keyOfField } from '../helpers';
import { SchemaPredicates } from '../ast/schemaPredicates';

export interface QueryResult {
  dependencies: Set<string>;
  partial: boolean;
  data: null | Data;
}

interface Context {
  partial: boolean;
  store: Store;
  variables: Variables;
  fragments: Fragments;
  schemaPredicates?: SchemaPredicates;
}

export const query = (
  store: Store,
  request: OperationRequest,
  data?: Data
): QueryResult => {
  initStoreState(0);
  const result = read(store, request, data);
  clearStoreState();
  return result;
};

const read = (
  store: Store,
  request: OperationRequest,
  input?: Data
): QueryResult => {
  const operation = getMainOperation(request.query);
  const rootKey = store.getRootKey(operation.operation);
  const rootSelect = getSelectionSet(operation);

  const ctx: Context = {
    variables: normalizeVariables(operation, request.variables),
    fragments: getFragments(request.query),
    partial: false,
    store,
    schemaPredicates: store.schemaPredicates,
  };

  const data =
    input !== undefined
      ? readRoot(ctx, rootKey, rootSelect, input)
      : readSelection(ctx, rootKey, rootSelect, Object.create(null));

  return {
    dependencies: getCurrentDependencies(),
    partial: data === undefined ? false : ctx.partial,
    data: data === undefined ? null : data,
  };
};

const readRoot = (
  ctx: Context,
  entityKey: string,
  select: SelectionSet,
  originalData: Data
): Data => {
  if (typeof originalData.__typename !== 'string') {
    return originalData;
  }

  const data = Object.create(null);
  data.__typename = originalData.__typename;

  const iter = new SelectionIterator(entityKey, entityKey, select, ctx);

  let node;
  while ((node = iter.next()) !== undefined) {
    const fieldAlias = getFieldAlias(node);
    const fieldValue = originalData[fieldAlias];

    if (
      node.selectionSet !== undefined &&
      fieldValue !== null &&
      !isScalar(fieldValue)
    ) {
      data[fieldAlias] = readRootField(ctx, getSelectionSet(node), fieldValue);
    } else {
      data[fieldAlias] = fieldValue;
    }
  }

  return data;
};

const readRootField = (
  ctx: Context,
  select: SelectionSet,
  originalData: null | Data | NullArray<Data>
): Data | NullArray<Data> | null => {
  if (Array.isArray(originalData)) {
    const newData = new Array(originalData.length);
    for (let i = 0, l = originalData.length; i < l; i++)
      newData[i] = readRootField(ctx, select, originalData[i]);
    return newData;
  } else if (originalData === null) {
    return null;
  }

  // Write entity to key that falls back to the given parentFieldKey
  const entityKey = ctx.store.keyOfEntity(originalData);
  if (entityKey !== null) {
    // We assume that since this is used for result data this can never be undefined,
    // since the result data has already been written to the cache
    const newData = Object.create(null);
    const fieldValue = readSelection(ctx, entityKey, select, newData);
    return fieldValue === undefined ? null : fieldValue;
  } else {
    const typename = originalData.__typename;
    return readRoot(ctx, typename, select, originalData);
  }
};

const readSelection = (
  ctx: Context,
  entityKey: string,
  select: SelectionSet,
  data: Data
): Data | undefined => {
  const { store, variables, schemaPredicates } = ctx;
  const isQuery = entityKey === store.getRootKey('query');
  if (!isQuery) addDependency(entityKey);

  // Get the __typename field for a given entity to check that it exists
  const typename = isQuery
    ? store.getRootKey('query')
    : store.getField(entityKey, '__typename');
  if (typeof typename !== 'string') {
    return undefined;
  }

  data.__typename = typename;
  const iter = new SelectionIterator(typename, entityKey, select, ctx);

  let node;
  let hasFields = false;
  while ((node = iter.next()) !== undefined) {
    // Derive the needed data from our node.
    const fieldName = getName(node);
    const fieldArgs = getFieldArguments(node, variables);
    const fieldAlias = getFieldAlias(node);
    const fieldKey = joinKeys(entityKey, keyOfField(fieldName, fieldArgs));
    const fieldValue = store.getRecord(fieldKey);

    if (isQuery) addDependency(fieldKey);

    // We temporarily store the data field in here, but undefined
    // means that the value is missing from the cache
    let dataFieldValue: void | DataField;

    const resolvers = store.resolvers[typename];
    if (resolvers !== undefined && typeof resolvers[fieldName] === 'function') {
      // We have a resolver for this field.
      // Prepare the actual fieldValue, so that the resolver can use it
      if (fieldValue !== undefined) {
        data[fieldAlias] = fieldValue;
      }

      const resolverValue = resolvers[fieldName](
        data,
        fieldArgs || {},
        store,
        ctx
      );

      const isNull = resolverValue === undefined || resolverValue === null;
      // When we have a schema we check for a user's resolver whether the field is nullable
      // Otherwise we trust the resolver and assume that it is
      if (node.selectionSet === undefined || isNull) {
        dataFieldValue = isNull ? undefined : resolverValue;
      } else {
        // When it has a selection set we are resolving an entity with a
        // subselection. This can either be a list or an object.
        dataFieldValue = resolveResolverResult(
          ctx,
          resolverValue,
          fieldKey,
          getSelectionSet(node),
          data[fieldAlias] as Data | Data[]
        );
      }
    } else if (node.selectionSet === undefined) {
      // The field is a scalar and can be retrieved directly
      dataFieldValue = fieldValue;
    } else {
      // We have a selection set which means that we'll be checking for links
      const fieldSelect = getSelectionSet(node);
      const link = store.getLink(fieldKey);

      if (link !== undefined) {
        const prevData = data[fieldAlias] as Data;
        dataFieldValue = resolveLink(ctx, link, fieldSelect, prevData);
      } else if (typeof fieldValue === 'object' && fieldValue !== null) {
        // The entity on the field was invalid but can still be recovered
        dataFieldValue = fieldValue;
      }
    }

    // When dataFieldValue is undefined that means that we have to check whether we can continue,
    // or whether this Data is now invalid, in which case we return undefined
    if (schemaPredicates !== undefined) {
      // If we can check against the schema an uncached field may be acceptable for partial results
      if (
        dataFieldValue === undefined &&
        schemaPredicates.isFieldNullable(typename, fieldName)
      ) {
        hasFields = true;
        data[fieldAlias] = null;
        ctx.partial = true;
      } else {
        return undefined;
      }
    } else if (dataFieldValue === undefined) {
      // Otherwise an uncached field means that the Data is invalid, so we return undefined
      return undefined;
    } else {
      // Otherwise we can set the field on data and continue
      hasFields = true;
      data[fieldAlias] = dataFieldValue;
    }
  }

  return isQuery && ctx.partial && !hasFields ? undefined : data;
};

const resolveResolverResult = (
  ctx: Context,
  result: DataField,
  key: string,
  select: SelectionSet,
  prevData: void | Data | Data[]
): DataField | undefined => {
  // When we are dealing with a list we have to call this method again.
  if (Array.isArray(result)) {
    // TODO: Convert to for-loop
    // @ts-ignore: Link cannot be expressed as a recursive type
    return result.map((childResult, index) => {
      const data = prevData !== undefined ? prevData[index] : undefined;
      const indexKey = joinKeys(key, `${index}`);
      // TODO: If SchemaPredicates.isListNullable is false we may need to return undefined for the entire list
      return resolveResolverResult(ctx, childResult, indexKey, select, data);
    });
  } else if (result === null) {
    return null;
  } else if (isDataOrKey(result)) {
    // We don't need to read the entity after exiting a resolver
    // we can just go on and read the selection further.
    const data = prevData === undefined ? Object.create(null) : prevData;
    const childKey =
      (typeof result === 'string' ? result : ctx.store.keyOfEntity(result)) ||
      key;
    // TODO: Copy over fields from result but check against schema whether that's safe
    return readSelection(ctx, childKey, select, data);
  }

  warning(
    false,
    'Invalid resolver value: The resolver at `%s` returned a scalar (number, boolean, etc)' +
      ', but the GraphQL query expects a selection set for this field.\n' +
      'If necessary, use Cache.resolve() to resolve a link or entity from the cache.',
    key
  );

  return undefined;
};

const resolveLink = (
  ctx: Context,
  link: Link | Link[],
  select: SelectionSet,
  prevData: void | Data | Data[]
): DataField | undefined => {
  if (Array.isArray(link)) {
    const newLink = new Array(link.length);
    for (let i = 0, l = link.length; i < l; i++) {
      const data = prevData !== undefined ? prevData[i] : undefined;
      newLink[i] = resolveLink(ctx, link[i], select, data);
    }

    // TODO: If SchemaPredicates.isListNullable is false we may need to return undefined for the entire list
    return newLink;
  } else if (link === null) {
    return null;
  } else {
    const data = prevData === undefined ? Object.create(null) : prevData;
    return readSelection(ctx, link, select, data);
  }
};

const isDataOrKey = (x: any): x is string | Data =>
  typeof x === 'string' ||
  (typeof x === 'object' &&
    x !== null &&
    typeof (x as any).__typename === 'string');
