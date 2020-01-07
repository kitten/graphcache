import {
  buildSchema,
  print,
  introspectionFromSchema,
  visit,
  DocumentNode,
  ASTKindToNode,
} from 'graphql';

import gql from 'graphql-tag';
import { fromValue, pipe, fromArray, toArray } from 'wonka';
import { Client, Operation } from 'urql/core';

import { populateExchange } from './populateExchange';

const schemaDef = `
  interface Node {
    id: ID!
  }

  type User implements Node {
    id: ID!
    name: String!
    age: Int!
    todos: [Todo]
  }

  type Todo implements Node {
    id: ID!
    text: String!
    creator: User!
  }

  union UnionType = User | Todo

  type Query {
    todos: [Todo!]
    users: [User!]!
  }

  type Mutation {
    addTodo: [Todo]
    removeTodo: [Node]
    updateTodo: [UnionType]
  }
`;

const getNodesByType = <T extends keyof ASTKindToNode, N = ASTKindToNode[T]>(
  query: DocumentNode,
  type: T
) => {
  let result: N[] = [];

  visit(query, {
    [type]: n => {
      result = [...result, n];
    },
  });
  return result;
};

const schema = introspectionFromSchema(buildSchema(schemaDef));

beforeEach(jest.clearAllMocks);

const exchangeArgs = {
  forward: a => a as any,
  client: {} as Client,
};

describe('on mutation', () => {
  const operation = {
    key: 1234,
    operationName: 'mutation',
    query: gql`
      mutation MyMutation {
        addTodo @populate
      }
    `,
  } as Operation;

  describe('mutation query', () => {
    it('matches snapshot', async () => {
      const response = pipe<Operation, any, Operation[]>(
        fromValue(operation),
        populateExchange({ schema })(exchangeArgs),
        toArray
      );
      expect(print(response[0].query)).toMatchInlineSnapshot(`
        "mutation MyMutation {
          addTodo {
            __typename
          }
        }
        "
      `);
    });
  });
});

describe('on query -> mutation', () => {
  const queryOp = {
    key: 1234,
    operationName: 'query',
    query: gql`
      query {
        todos {
          id
          text
          creator {
            id
            name
          }
        }
        users {
          todos {
            text
          }
        }
      }
    `,
  } as Operation;

  const mutationOp = {
    key: 5678,
    operationName: 'mutation',
    query: gql`
      mutation MyMutation {
        addTodo @populate
      }
    `,
  } as Operation;

  describe('mutation query', () => {
    it('matches snapshot', async () => {
      const response = pipe<Operation, any, Operation[]>(
        fromArray([queryOp, mutationOp]),
        populateExchange({ schema })(exchangeArgs),
        toArray
      );

      expect(print(response[1].query)).toMatchInlineSnapshot(`
        "mutation MyMutation {
          addTodo {
            ...Todo_PopulateFragment_0
            ...Todo_PopulateFragment_1
          }
        }

        fragment Todo_PopulateFragment_0 on Todo {
          id
          text
          creator {
            id
            name
          }
        }

        fragment Todo_PopulateFragment_1 on Todo {
          text
        }
        "
      `);
    });
  });
});

describe('on (query w/ fragment) -> mutation', () => {
  const queryOp = {
    key: 1234,
    operationName: 'query',
    query: gql`
      query {
        todos {
          ...TodoFragment
          creator {
            ...CreatorFragment
          }
        }
      }

      fragment TodoFragment on Todo {
        id
        text
      }

      fragment CreatorFragment on User {
        id
        name
      }
    `,
  } as Operation;

  const mutationOp = {
    key: 5678,
    operationName: 'mutation',
    query: gql`
      mutation MyMutation {
        addTodo @populate {
          ...TodoFragment
        }
      }

      fragment TodoFragment on Todo {
        id
        text
      }
    `,
  } as Operation;

  describe('mutation query', () => {
    it('matches snapshot', async () => {
      const response = pipe<Operation, any, Operation[]>(
        fromArray([queryOp, mutationOp]),
        populateExchange({ schema })(exchangeArgs),
        toArray
      );

      expect(print(response[1].query)).toMatchInlineSnapshot(`
        "mutation MyMutation {
          addTodo {
            ...Todo_PopulateFragment_0
            ...TodoFragment
          }
        }

        fragment TodoFragment on Todo {
          id
          text
        }

        fragment Todo_PopulateFragment_0 on Todo {
          ...TodoFragment
          creator {
            ...CreatorFragment
          }
        }

        fragment CreatorFragment on User {
          id
          name
        }
        "
      `);
    });

    it('includes user fragment', () => {
      const response = pipe<Operation, any, Operation[]>(
        fromArray([queryOp, mutationOp]),
        populateExchange({ schema })(exchangeArgs),
        toArray
      );

      const fragments = getNodesByType(response[1].query, 'FragmentDefinition');
      expect(
        fragments.filter(f => f.name.value === 'TodoFragment')
      ).toHaveLength(1);
    });
  });
});

describe('on (query w/ unused fragment) -> mutation', () => {
  const queryOp = {
    key: 1234,
    operationName: 'query',
    query: gql`
      query {
        todos {
          id
          text
        }
        users {
          ...UserFragment
        }
      }

      fragment UserFragment on User {
        id
        name
      }
    `,
  } as Operation;

  const mutationOp = {
    key: 5678,
    operationName: 'mutation',
    query: gql`
      mutation MyMutation {
        addTodo @populate
      }
    `,
  } as Operation;

  describe('mutation query', () => {
    it('matches snapshot', async () => {
      const response = pipe<Operation, any, Operation[]>(
        fromArray([queryOp, mutationOp]),
        populateExchange({ schema })(exchangeArgs),
        toArray
      );

      expect(print(response[1].query)).toMatchInlineSnapshot(`
        "mutation MyMutation {
          addTodo {
            ...Todo_PopulateFragment_0
          }
        }

        fragment Todo_PopulateFragment_0 on Todo {
          id
          text
        }
        "
      `);
    });

    it('excludes user fragment', () => {
      const response = pipe<Operation, any, Operation[]>(
        fromArray([queryOp, mutationOp]),
        populateExchange({ schema })(exchangeArgs),
        toArray
      );

      const fragments = getNodesByType(response[1].query, 'FragmentDefinition');
      expect(
        fragments.filter(f => f.name.value === 'UserFragment')
      ).toHaveLength(0);
    });
  });
});

describe('on query -> (mutation w/ interface return type)', () => {
  const queryOp = {
    key: 1234,
    operationName: 'query',
    query: gql`
      query {
        todos {
          id
          name
        }
        users {
          id
          text
        }
      }
    `,
  } as Operation;

  const mutationOp = {
    key: 5678,
    operationName: 'mutation',
    query: gql`
      mutation MyMutation {
        removeTodo @populate
      }
    `,
  } as Operation;

  describe('mutation query', () => {
    it('matches snapshot', async () => {
      const response = pipe<Operation, any, Operation[]>(
        fromArray([queryOp, mutationOp]),
        populateExchange({ schema })(exchangeArgs),
        toArray
      );

      expect(print(response[1].query)).toMatchInlineSnapshot(`
        "mutation MyMutation {
          removeTodo {
            ...Todo_PopulateFragment_0
            ...User_PopulateFragment_0
          }
        }

        fragment Todo_PopulateFragment_0 on Todo {
          id
          name
        }

        fragment User_PopulateFragment_0 on User {
          id
          text
        }
        "
      `);
    });
  });
});

describe('on query -> (mutation w/ union return type)', () => {
  const queryOp = {
    key: 1234,
    operationName: 'query',
    query: gql`
      query {
        todos {
          id
          name
        }
        users {
          id
          text
        }
      }
    `,
  } as Operation;

  const mutationOp = {
    key: 5678,
    operationName: 'mutation',
    query: gql`
      mutation MyMutation {
        updateTodo @populate
      }
    `,
  } as Operation;

  describe('mutation query', () => {
    it('matches snapshot', async () => {
      const response = pipe<Operation, any, Operation[]>(
        fromArray([queryOp, mutationOp]),
        populateExchange({ schema })(exchangeArgs),
        toArray
      );

      expect(print(response[1].query)).toMatchInlineSnapshot(`
        "mutation MyMutation {
          updateTodo {
            ...User_PopulateFragment_0
            ...Todo_PopulateFragment_0
          }
        }

        fragment User_PopulateFragment_0 on User {
          id
          text
        }

        fragment Todo_PopulateFragment_0 on Todo {
          id
          name
        }
        "
      `);
    });
  });
});

describe('on query -> teardown -> mutation', () => {
  const queryOp = {
    key: 1234,
    operationName: 'query',
    query: gql`
      query {
        todos {
          id
          text
        }
      }
    `,
  } as Operation;

  const teardownOp = {
    key: queryOp.key,
    operationName: 'teardown',
  } as Operation;

  const mutationOp = {
    key: 5678,
    operationName: 'mutation',
    query: gql`
      mutation MyMutation {
        addTodo @populate
      }
    `,
  } as Operation;

  describe('mutation query', () => {
    it('matches snapshot', async () => {
      const response = pipe<Operation, any, Operation[]>(
        fromArray([queryOp, teardownOp, mutationOp]),
        populateExchange({ schema })(exchangeArgs),
        toArray
      );

      expect(print(response[2].query)).toMatchInlineSnapshot(`
        "mutation MyMutation {
          addTodo {
            __typename
          }
        }
        "
      `);
    });

    it('only requests __typename', () => {
      const response = pipe<Operation, any, Operation[]>(
        fromArray([queryOp, teardownOp, mutationOp]),
        populateExchange({ schema })(exchangeArgs),
        toArray
      );
      getNodesByType(response[2].query, 'Field').forEach(field => {
        expect(field.name.value).toMatch(/addTodo|__typename/);
      });
    });
  });
});
