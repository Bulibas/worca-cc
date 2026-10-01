// test/helpers/mcp-plugin-fixture.mjs — plugin dirs that ship MCP servers (spec §4.1)
// for the plugin suites.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const JIRA = {
  type: 'stdio', command: 'node', args: ['./mcp/jira.mjs'],
  env: { JIRA_URL: { field: 'baseUrl' }, JIRA_TOKEN: { field: 'token' } },
  fields: [
    { key: 'baseUrl', label: 'Jira URL', required: true, default: 'https://acme.atlassian.net' },
    { key: 'token', label: 'API token', secret: true, required: true },
  ],
  description: 'Search and read Jira issues',
};
export const SENTRY = {
  type: 'http', url: 'https://mcp.sentry.dev/mcp',
  headers: { Authorization: { field: 'token', prefix: 'Bearer ' }, 'X-Sentry-Org': { field: 'org' } },
  fields: [
    { key: 'token', label: 'Sentry token', secret: true, oauth: true, required: true },
    { key: 'org', label: 'Organization', required: true },
  ],
  description: 'Sentry issues and events',
};

/** Write a plugin tree: manifest (range null = no engines) + mcp/jira.mjs + extra files. */
export function writeMcpPlugin(root, { name, range = '>=5 <6', mcpServers = { jira: JIRA }, files = {} }) {
  const all = {
    'worca-cc-plugin.json': JSON.stringify({
      name, version: '1.0.0', ...(range === null ? {} : { engines: { 'worca-cc-api': range } }), mcpServers,
    }),
    'mcp/jira.mjs': '// fixture server\n',
    ...files,
  };
  for (const [rel, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}
