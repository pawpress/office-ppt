import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLoTools } from '../lib/tools.js';

// Raw tools.register() parameters must be JSON Schema, not the defineTool DSL.
function checkRequired(node, path) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((value, index) => checkRequired(value, `${path}[${index}]`));
    return;
  }
  if (Object.hasOwn(node, 'required')) {
    assert.ok(Array.isArray(node.required), `${path}.required must be an array`);
    for (const name of node.required) {
      assert.equal(typeof name, 'string', `${path}.required entries must be strings`);
      assert.ok(Object.hasOwn(node.properties ?? {}, name), `${path}: missing property ${name}`);
    }
  }
  // Walk schema positions only: a property may itself be named "required".
  for (const [name, schema] of Object.entries(node.properties ?? {})) {
    checkRequired(schema, `${path}.properties.${name}`);
  }
  if (node.items) checkRequired(node.items, `${path}.items`);
  for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
    if (node[keyword]) checkRequired(node[keyword], `${path}.${keyword}`);
  }
}

test('all LibreOffice tools use array-valued JSON Schema required keywords', () => {
  const tools = buildLoTools();
  assert.deepEqual(tools.map(tool => tool.name), ['lo_probe', 'lo_build', 'lo_render', 'lo_convert']);
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object');
    checkRequired(tool.parameters, `${tool.name}.parameters`);
    checkRequired(tool.output.schema, `${tool.name}.output`);
  }
  assert.deepEqual(tools.find(tool => tool.name === 'lo_convert').parameters.required, ['source', 'to']);
  assert.deepEqual(tools.find(tool => tool.name === 'lo_render').parameters.required, ['source']);
});
