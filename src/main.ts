import { runCommand } from './cli.js';
import { pathToFileURL } from 'node:url';

// Deliberate CLI entry only. No automatic env/secret discovery or retry.
// If SDK login refuses to settle, terminating THIS process closes its own
// sockets and releases its OS locks. No other process/service is signalled.
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  void runCommand(process.argv.slice(2)).then(code=>process.exit(code),()=>{process.stderr.write('bridge_command_failed\n');process.exit(1);});
}
