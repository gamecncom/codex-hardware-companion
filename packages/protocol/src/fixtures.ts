import type { CatalogSnapshot, TaskRef } from './index.js';

export const fixtureRefs = {
  a: { connectorId:'cn-fixture', projectId:'pr-alpha', threadId:'thread-a' },
  b: { connectorId:'cn-fixture', projectId:'pr-alpha', threadId:'thread-b' },
  c: { connectorId:'cn-fixture', projectId:'pr-beta', threadId:'thread-c' },
} satisfies Record<string,TaskRef>;

export const fixtureCatalog:CatalogSnapshot = {
  snapshotId:'snap-fixture-1', catalogVersion:'1',
  projects:[
    { projectId:'pr-alpha', connectorId:'cn-fixture', name:'Alpha Project', source:'local', taskCount:2 },
    { projectId:'pr-beta', connectorId:'cn-fixture', name:'Beta Project', source:'local', taskCount:1 },
  ],
  tasks:[
    { ...fixtureRefs.a, title:'Task A', titleSource:'codex', status:'idle', unread:false, revision:'1', updatedAt:'2026-09-17T00:00:00.000Z' },
    { ...fixtureRefs.b, title:'Task B', titleSource:'codex', status:'running', unread:false, revision:'2', updatedAt:'2026-09-17T00:00:01.000Z' },
    { ...fixtureRefs.c, title:'Task C', titleSource:'codex', status:'completed', unread:true, revision:'3', updatedAt:'2026-09-17T00:00:02.000Z' },
  ]
};
