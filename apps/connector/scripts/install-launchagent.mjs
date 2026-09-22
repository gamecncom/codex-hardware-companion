#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
const label='cn.hardware-companion.connector';
const launchAgents=join(homedir(),'Library','LaunchAgents');
const packageRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const node=process.env.HC_CONNECTOR_NODE??process.execPath;
const cli=process.env.HC_CONNECTOR_CLI??join(packageRoot,'dist','cli.js');
const xml=(value)=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
await access(node,constants.X_OK); await access(cli,constants.X_OK).catch(async()=>access(cli,constants.F_OK));
const plist=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(cli)}</string><string>daemon</string><string>start</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer></dict></plist>`;
if(process.argv.includes('--install')){await mkdir(launchAgents,{recursive:true});await writeFile(join(launchAgents,`${label}.plist`),plist);console.log(JSON.stringify({ok:true,operation:'install',label,path:join(launchAgents,`${label}.plist`),loaded:false,launchctl:'not-called'}));}else console.log(JSON.stringify({ok:true,operation:'install preview',label,loaded:false,requiresExplicitInstall:true,plist}));
