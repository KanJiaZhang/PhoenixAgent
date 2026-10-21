#!/usr/bin/env node
/**
 * The MCP server: a thin stdio bridge to the HTTP API.
 *
 * It does not define tools. It asks the service for its catalogue (`GET /v1/tools`) and forwards calls, so a
 * route added on the server appears here with no change and a route removed cannot linger in a client. This is
 * the same rule PhoenixGraph's own MCP plugin follows, and it is why there is no second list to keep in sync.
 *
 * `--selftest` lists the tools, calls a read-only one, and exits non-zero if either answer is wrong.
 */

import { createInterface } from 'node:readline';

const API = process.env.PAGENT_API ?? 'http://127.0.0.1:8790';
const KEY = process.env.PAGENT_API_KEY ?? '';

async function call(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  return text.length > 0 ? JSON.parse(text) : null;
}

async function tools() {
  const catalogue = await call('GET', '/v1/tools');
  return catalogue.tools.map((tool) => ({
    name: tool.path.replace(/^\//, '').replace(/\//g, '.').replace(/\.:/g, '.by.'),
    description: `${tool.summary} (needs role ${tool.role})`,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(tool.input.map((name) => [name, { type: name === 'step' || name === 'budget' ? 'number' : 'string' }])),
    },
    _method: tool.method,
    _path: tool.path,
    _input: tool.input,
  }));
}

async function invoke(name, args) {
  const catalogue = await tools();
  const tool = catalogue.find((entry) => entry.name === name);
  if (!tool) throw new Error(`unknown tool '${name}'; the service advertises ${catalogue.map((entry) => entry.name).join(', ')}`);
  let path = tool._path;
  for (const parameter of tool._input) {
    if (args[parameter] !== undefined && path.includes(':')) {
      path = path.replace(`:${parameter}`, encodeURIComponent(String(args[parameter])));
    }
  }
  const isGet = tool._method === 'GET';
  const query = isGet
    ? '?' + new URLSearchParams(Object.fromEntries(Object.entries(args).map(([key, value]) => [key, String(value)]))).toString()
    : '';
  const body = isGet ? undefined : Object.fromEntries(Object.entries(args));
  return call(tool._method, `${path}${query}`, body);
}

async function selftest() {
  const catalogue = await tools();
  if (catalogue.length === 0) throw new Error('the service advertised no tools');
  const health = await call('GET', '/v1/health');
  if (!health.ok) throw new Error('the service is not healthy');
  const risk = await invoke(catalogue.find((entry) => entry.name === 'v1.risk.report')?.name ?? catalogue[0].name, {});
  if (risk === null || typeof risk !== 'object') throw new Error('a tool call returned nothing');
  console.log(`mcp selftest: ${catalogue.length} tools, health ok, one call ok`);
}

async function main() {
  if (process.argv.includes('--selftest')) {
    await selftest();
    // undici keeps sockets alive; a one-shot CLI must not wait for them
    process.exit(0);
  }
  if (process.argv.includes('--list')) {
    process.stdout.write(JSON.stringify({ tools: (await tools()).map(({ _method, _path, _input, ...tool }) => tool) }));
    process.exit(0);
  }
  const lines = createInterface({ input: process.stdin });
  const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`);
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    const { id, method, params } = message;
    try {
      if (method === 'initialize') {
        send({ jsonrpc: '2.0', id, result: {
          protocolVersion: '2026-07-28',
          capabilities: { tools: {} },
          serverInfo: { name: 'phoenixagent', version: '0.1.0' },
        } });
      } else if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: (await tools()).map(({ _method, _path, _input, ...tool }) => tool) } });
      } else if (method === 'tools/call') {
        const result = await invoke(params.name, params.arguments ?? {});
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
      } else {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
      }
    } catch (error) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: error.message } });
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
