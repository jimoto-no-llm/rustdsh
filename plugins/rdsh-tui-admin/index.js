import { createCatalogService } from './catalog.js';
import { httpActions } from './http-actions.js';
import { createCatalogCodec, schemaToJSON } from './schema.js';

export const name = 'rdsh-tui-admin';
export const inject = ['typert'];

export function contribution() {
  return { package: name, face: 'host', schemas: [], model: { services: [], events: [], objects: [] },
    invocations: [{ id: `${name}#rdshTuiAdmin/catalog`, service: 'rdshTuiAdmin', namespace: 'rdshTuiAdmin',
      method: 'catalog', invocation: { kind: 'direct' }, parameters: [],
      result: { mode: 'strict', typeSymbol: `${name}#Catalog`, create: createCatalogCodec } }] };
}

export function apply(ctx) {
  const service = createCatalogService(ctx.typert, schemaToJSON, httpActions);
  // Public TypertGatewayBinding declaration, identical to bindTypertRemote's
  // value contract. This service uses no call-local Context and needs no
  // invocation accessor. Registering a descriptor alone does not export it.
  service.typertRemote = Object.freeze({ service, serviceKey: 'rdshTuiAdmin', namespace: 'rdshTuiAdmin' });
  ctx.provide('rdshTuiAdmin', service);
  ctx.typert.register(contribution());
  return ctx.effect(() => () => service.dispose());
}
