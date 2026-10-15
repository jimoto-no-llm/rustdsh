import { apply } from './cleanup-diagnostic-plugin.mjs';

apply({
  get: () => ({ name: 'headless' }),
  on: () => () => {},
  effect: factory => factory()(),
});
if (process.env.RDSH_TEST_FORCE_EXIT === '1') process.exit(0);
