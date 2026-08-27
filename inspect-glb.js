import fs from 'fs';
import * as THREE from 'three';
// We need to use a headless GLTF loader. We can just read the JSON part of the GLB.
const glbBuffer = fs.readFileSync('./public/models/weapon.glb');

const magic = glbBuffer.readUInt32LE(0);
if (magic !== 0x46546C67) throw new Error('Not a GLB');
const version = glbBuffer.readUInt32LE(4);
const length = glbBuffer.readUInt32LE(8);

const jsonChunkLength = glbBuffer.readUInt32LE(12);
const jsonChunkType = glbBuffer.readUInt32LE(16);
if (jsonChunkType !== 0x4E4F534A) throw new Error('Not JSON chunk');

const jsonBuffer = glbBuffer.slice(20, 20 + jsonChunkLength);
const json = JSON.parse(jsonBuffer.toString('utf8'));

console.log("Nodes:");
json.nodes.forEach((node, i) => {
  console.log(`[${i}] name: "${node.name}", children: ${JSON.stringify(node.children)}, mesh: ${node.mesh}, skin: ${node.skin}`);
});

console.log("\nSkins:");
if (json.skins) {
  json.skins.forEach((skin, i) => {
    console.log(`[${i}] name: "${skin.name}", joints: ${JSON.stringify(skin.joints)}`);
  });
}

console.log("\nAnimations:");
if (json.animations) {
  json.animations.forEach((anim, i) => {
    console.log(`[${i}] name: "${anim.name}"`);
  });
}
