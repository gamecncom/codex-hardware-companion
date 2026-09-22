import { createHash } from 'node:crypto';
import path from 'node:path';
export interface ProjectMapping { projectId:string; name:string; root:string; }
export function stableProjectId(root:string){ return `local_${createHash('sha256').update(path.resolve(root)).digest('hex').slice(0,24)}`; }
export function mapThreadToProject(cwd:string|undefined,mappings:ProjectMapping[]){ if(!cwd)return undefined; const abs=path.resolve(cwd); return mappings.filter(m=>{const r=path.resolve(m.root);return abs===r||abs.startsWith(r+path.sep)}).sort((a,b)=>path.resolve(b.root).length-path.resolve(a.root).length)[0]; }
export function addMapping(name:string,root:string):ProjectMapping { const resolved=path.resolve(root); return {name,root:resolved,projectId:stableProjectId(resolved)}; }
