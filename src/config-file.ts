import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, normalize, dirname } from 'node:path';

export function assertPrivateDirectory(directory:string) {
  try {
    const s=lstatSync(directory);
    if(!isAbsolute(directory)||realpathSync(directory)!==directory||!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o777)!==0o700)throw new Error('invalid');
  } catch {throw new Error('private_directory_denied');}
}
export function readBoundedFile(path:string,privateFile:boolean,maxBytes:number) {
  let fd:number|undefined;
  try {
    if(!isAbsolute(path)||normalize(path)!==path)throw new Error('invalid');
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const s=fstatSync(fd);
    if(!s.isFile()||s.nlink!==1||s.size>maxBytes||(privateFile&&(s.uid!==process.getuid?.()||(s.mode&0o777)!==0o600)))throw new Error('invalid');
    const buffer=Buffer.alloc(maxBytes+1);let size=0;
    while(size<buffer.length){const count=readSync(fd,buffer,size,buffer.length-size,null);if(!count)break;size+=count;}
    if(size>maxBytes)throw new Error('invalid');return new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,size));
  } catch {throw new Error('private_file_denied');}finally {if(fd!==undefined)closeSync(fd);}
}
export function readDeploymentFile(path:string,privateFile=true) {
  try {if(privateFile)assertPrivateDirectory(dirname(path));return JSON.parse(readBoundedFile(path,privateFile,65536)) as unknown;}catch {throw new Error('deployment_file_denied');}
}
