import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {profileText} from '../scripts/tunnel-plan.mjs';

test('adopted official binary reproduces double-read EOF and corrected single-read passes to a config-only sentinel',()=>{
 const result=spawnSync('/usr/bin/python3',['scripts/check-tunnel-client-pipe.py'],{stdio:['ignore','pipe','ignore'],encoding:'utf8',timeout:15000,maxBuffer:4096});
 assert.equal(result.status,0,'offline_pipe_check_failed');
 let data;try{data=JSON.parse(result.stdout);}catch{assert.fail('offline_result_unavailable');}
 assert.equal(data.offlineOnly,true);assert.equal(data.cases.length,2);
 const [legacy,single]=data.cases;
 assert.equal(legacy.legacyDuplicateReference,true);assert.equal(legacy.fixedClassification,'api_key_pipe_empty');assert.equal(legacy.clientExit,1);
 assert.equal(single.legacyDuplicateReference,false);assert.equal(single.fixedClassification,'intentional_post_key_config_sentinel');assert.equal(single.clientExit,1);
 for(const item of data.cases){assert.equal(item.networkPolicy,'deny_all');assert.equal(item.realKeyRead,false);}
 const profile=profileText({tunnelId:'tunnel_'+'a'.repeat(32),organizationId:'org-mock',issuer:'https://mock.us.auth0.com/'});
 assert.equal(profile.includes('api_key:'),false);assert.equal(profile.includes('/dev/fd/4'),false);
});
