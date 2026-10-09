import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if(process.platform!=='darwin'){process.stderr.write('keychain_build_requires_macos\n');process.exit(2);}
mkdirSync('dist/native/module-cache',{recursive:true});
const result=spawnSync('/usr/bin/xcrun',['swiftc','-O','-suppress-warnings','-module-cache-path','dist/native/module-cache','native/keychain-reader.swift','-o','dist/native/keychain-reader','-framework','Security','-framework','LocalAuthentication'],{stdio:'inherit',timeout:60000});
if(result.error||result.status!==0){process.stderr.write('keychain_build_failed\n');process.exit(2);}
// Compilation only. Never execute the helper or query any keychain here.
