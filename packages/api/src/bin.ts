#!/usr/bin/env node
/**
 * The service entry point: start the HTTP API and print what a client needs.
 *
 * With no `PAGENT_API_KEYS` configured it generates one and prints it once - a demo should not be open by
 * accident, and a fresh checkout should not need a config file before it answers.
 */

import { createAgentServer } from './server.ts';

const server = createAgentServer({ port: Number(process.env.PAGENT_PORT ?? 8790) });
const url = await server.listen();
console.log(`PhoenixAgent listening on ${url}`);
console.log(`console:  ${url}/`);
if (server.auth.generated) {
  const [key, principal] = [...server.auth.keys.entries()][0]!;
  console.log(`API key:  ${key}  (role ${principal.role}; set PAGENT_API_KEYS to configure your own)`);
} else {
  console.log(`API keys: ${server.auth.keys.size} configured`);
}
console.log('try:      curl -s -H "X-API-Key: <key>" ' + url + '/v1/tools');
