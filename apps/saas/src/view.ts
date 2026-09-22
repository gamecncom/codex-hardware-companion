import { randomUUID } from 'node:crypto';
import type { TaskRef, TaskSummary } from '@companion/protocol';
export type ViewDescriptor={viewId:string;serverEpoch:string;revision:string;target?:TaskRef;catalogVersion:string;screen:'projects'|'tasks'|'detail'|'transcript'|'pairing';items:Array<{id:string;label:string;action:string}>;jpegPath?:string};
export function makeView(screen:ViewDescriptor['screen'],items:ViewDescriptor['items'],target?:TaskRef,revision='1'):ViewDescriptor{return {viewId:`view-${randomUUID()}`,serverEpoch:'saas-local',revision,target,catalogVersion:'1',screen,items};}
export function taskItems(tasks:TaskSummary[]){return tasks.map(t=>({id:t.threadId,label:t.title,action:'open'}));}
