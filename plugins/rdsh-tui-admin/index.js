import { createCatalogService } from './catalog.js';
import { httpActions } from './http-actions.js';
import { createCatalogCodec, schemaToJSON, createDocumentCodec, createDocumentSavedCodec,
  createDocumentContentCodec, createDocumentRevisionCodec } from './schema.js';
import { hostModule } from './host-runtime.js';
import { createSettingsDocuments } from './settings-document.js';

export const name = 'rdsh-tui-admin';
export const inject = ['typert'];

export function contribution() {
  const documentMethod = (method, parameters, create) => ({ id: `${name}#rdshTuiAdmin/${method}`,
    service: 'rdshTuiAdmin', namespace: 'rdshTuiAdmin', method, invocation: { kind: 'direct' }, parameters,
    result: { mode: 'strict', typeSymbol: `${name}#${method}Result`, create } });
  const parameter = (name, create) => ({ name, wire: name, source: 'json',
    codec: { mode: 'strict', typeSymbol: `rdsh-tui-admin#${name}`, create } });
  return { package: name, face: 'host', schemas: [], model: { services: [], events: [], objects: [] },
    invocations: [{ id: `${name}#rdshTuiAdmin/catalog`, service: 'rdshTuiAdmin', namespace: 'rdshTuiAdmin',
      method: 'catalog', invocation: { kind: 'direct' }, parameters: [],
      result: { mode: 'strict', typeSymbol: `${name}#Catalog`, create: createCatalogCodec } },
    documentMethod('readSettingsDocument', [], createDocumentCodec),
    documentMethod('saveSettingsDocument', [parameter('content', createDocumentContentCodec),
      parameter('expectedRevision', createDocumentRevisionCodec)], createDocumentSavedCodec)] };
}

export async function apply(ctx) {
  const { TypertRemoteService, RemoteError } = await hostModule(ctx, '@deepseek-ai/dsh-typert-protocol');
  const catalog = createCatalogService(ctx.typert, schemaToJSON, httpActions);
  const documents = createSettingsDocuments(ctx, RemoteError);
  class AdminService extends TypertRemoteService {
    constructor() { super(ctx, 'rdshTuiAdmin'); }
    catalog() { return catalog.catalog(); }
    assertOperator() {
      const connection = this.ctx.get('connection');
      if (!connection || !this.ctx.invocation?.peer || this.ctx.invocation.peer !== connection.operator)
        throw new RemoteError('gateway/forbidden', '設定文書の操作には認証済みoperatorが必要です。', {});
    }
    readSettingsDocument() { this.assertOperator(); return documents.read(); }
    saveSettingsDocument(content, expectedRevision) { this.assertOperator(); return documents.save(content, expectedRevision); }
  }
  new AdminService();
  ctx.typert.register(contribution());
  return ctx.effect(() => () => catalog.dispose());
}
