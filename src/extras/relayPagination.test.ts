import gql from 'graphql-tag';
import { query, write } from '../operations';
import { Store } from '../store';
import { relayPagination } from './relayPagination';

it('works with forward pagination', () => {
  const Pagination = gql`
    query($cursor: String) {
      items(first: 1, after: $cursor) {
        __typename
        edges {
          __typename
          node {
            __typename
            id
          }
        }
        pageInfo {
          __typename
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const store = new Store(undefined, {
    Query: {
      items: relayPagination(),
    },
  });

  const pageOne = {
    __typename: 'Query',
    items: {
      __typename: 'ItemsConnection',
      edges: [
        {
          __typename: 'ItemEdge',
          node: {
            __typename: 'Item',
            id: '1',
          },
        },
      ],
      pageInfo: {
        __typename: 'PageInfo',
        hasNextPage: true,
        endCursor: '1',
      },
    },
  };

  const pageTwo = {
    __typename: 'Query',
    items: {
      __typename: 'ItemsConnection',
      edges: [
        {
          __typename: 'ItemEdge',
          node: {
            __typename: 'Item',
            id: '2',
          },
        },
      ],
      pageInfo: {
        __typename: 'PageInfo',
        hasNextPage: false,
        endCursor: null,
      },
    },
  };

  write(store, { query: Pagination, variables: { cursor: null } }, pageOne);
  write(store, { query: Pagination, variables: { cursor: '1' } }, pageTwo);

  const res = query(store, { query: Pagination });

  expect(res.partial).toBe(false);
  expect(res.data).toEqual({
    ...pageTwo,
    items: {
      ...pageTwo.items,
      edges: [pageOne.items.edges[0], pageTwo.items.edges[0]],
    },
  });
});

it('works with backwards pagination', () => {
  const Pagination = gql`
    query($cursor: String) {
      items(last: 1, before: $cursor) {
        __typename
        edges {
          __typename
          node {
            __typename
            id
          }
        }
        pageInfo {
          __typename
          hasPreviousPage
          startCursor
        }
      }
    }
  `;

  const store = new Store(undefined, {
    Query: {
      items: relayPagination(),
    },
  });

  const pageOne = {
    __typename: 'Query',
    items: {
      __typename: 'ItemsConnection',
      edges: [
        {
          __typename: 'ItemEdge',
          node: {
            __typename: 'Item',
            id: '2',
          },
        },
      ],
      pageInfo: {
        __typename: 'PageInfo',
        hasPreviousPage: true,
        startCursor: '2',
      },
    },
  };

  const pageTwo = {
    __typename: 'Query',
    items: {
      __typename: 'ItemsConnection',
      edges: [
        {
          __typename: 'ItemEdge',
          node: {
            __typename: 'Item',
            id: '1',
          },
        },
      ],
      pageInfo: {
        __typename: 'PageInfo',
        hasPreviousPage: false,
        startCursor: null,
      },
    },
  };

  write(store, { query: Pagination, variables: { cursor: null } }, pageOne);
  write(store, { query: Pagination, variables: { cursor: '2' } }, pageTwo);

  const res = query(store, { query: Pagination });

  expect(res.partial).toBe(false);
  expect(res.data).toEqual({
    ...pageTwo,
    items: {
      ...pageTwo.items,
      edges: [pageTwo.items.edges[0], pageOne.items.edges[0]],
    },
  });
});
