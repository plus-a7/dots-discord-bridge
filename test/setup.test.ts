import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync,mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Alias probes use only explicitly created dummy package files, never private
// config, env, credential, session or real native-helper data.
test('public setup checker denies root JSON symlink, dependency parent escape, oversized JSON and unexpected package paths',()=>{
  for(const mode of ['root-link','parent-link','oversize','package-path'] as const) {
    const directory=mkdtempSync(join(tmpdir(),'bridge-setup-')),root=join(directory,'checkout'),outside=join(directory,'dummy-outside');mkdirSync(root);mkdirSync(outside);mkdirSync(join(root,'scripts'));
    try {
      const script=join(root,'scripts/check-setup.mjs');copyFileSync(fileURLToPath(new URL('../../scripts/check-setup.mjs',import.meta.url)),script);
      const dependencies={'@modelcontextprotocol/server':'2.3.1','discord.js':'14.27.0',standardwebhooks:'1.1.1',zod:'4.6.5','@types/node':'26.6.4',typescript:'7.0.2'};
      for(const [name,version] of Object.entries(dependencies)) {const d=join(mode==='parent-link'&&name==='zod'?outside:join(root,'node_modules'),name);mkdirSync(d,{recursive:true});writeFileSync(join(d,'package.json'),JSON.stringify({name,version}));}
      const selected:Record<string,string>={...dependencies};
      if(mode==='package-path') {delete selected.zod;selected['../../dummy-outside']='1.0.0';writeFileSync(join(outside,'package.json'),JSON.stringify({version:'1.0.0'}));}
      const p=JSON.stringify({dependencies:selected});
      if(mode==='root-link') {writeFileSync(join(outside,'dummy-package.json'),p);symlinkSync(join(outside,'dummy-package.json'),join(root,'package.json'));}
      else writeFileSync(join(root,'package.json'),mode==='oversize'?p+' '.repeat(65537):p);
      if(mode==='parent-link')symlinkSync(join(outside,'zod'),join(root,'node_modules/zod'));
      const result=spawnSync(process.execPath,[script],{env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe'],timeout:10000});
      assert.equal(result.status,2);assert.equal(result.stderr.length,0);const report=JSON.parse(result.stdout.toString());assert.equal(report.checks.dependencies,false);assert.equal(report.offlineReady,false);assert.equal(report.liveReady,false);assert.doesNotMatch(result.stdout.toString(),/dummy-outside|\/Users\/|public_file_denied/);
    } finally {rmSync(directory,{recursive:true,force:true});}
  }
});
