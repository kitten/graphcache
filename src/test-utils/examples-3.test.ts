import gql from 'graphql-tag';
import { query, write } from '../operations';
import { Store } from '../store';

it('allows viewer fields to overwrite the root Query data', () => {
  const store = new Store();
  const get = gql`
    {
      int
    }
  `;
  const set = gql`
    mutation {
      mutate {
        viewer {
          int
        }
      }
    }
  `;

  write(
    store,
    { query: get },
    {
      __typename: 'Query',
      int: 42,
    }
  );

  write(
    store,
    { query: set },
    {
      __typename: 'Mutation',
      mutate: {
        __typename: 'MutateResult',
        viewer: {
          __typename: 'Query',
          int: 43,
        },
      },
    }
  );

  const res = query(store, { query: get });

  expect(res.partial).toBe(false);
  expect(res.data).toEqual({
    __typename: 'Query',
    int: 43,
  });
});
