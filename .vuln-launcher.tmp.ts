import { LinuxArchExecutionLayer } from './src/agent-kernel/linux-arch-execution-layer';
import { EventBus } from './src/kernel/core/event-bus';
import { ProcessLauncher } from './src/host/launcher/process-launcher';

async function main() {
  const layer = new LinuxArchExecutionLayer({ defaultAgentId: 'test', execRoot: process.cwd() });
  const pl = new ProcessLauncher(layer, new EventBus());
  const cases = [
    { label: 'binaryPath=node -e (bare)', req: { programId: 'x', binaryPath: 'node', args: ['-e', 'console.log("PWN")'], mode: 'managed' as any } },
    { label: 'binaryPath=/bin/bash', req: { programId: 'x', binaryPath: '/bin/bash', args: ['-c', 'echo pwn'], mode: 'managed' as any } },
    { label: 'binaryPath=code-server', req: { programId: 'x', binaryPath: 'code-server', args: [], mode: 'managed' as any } },
  ];
  for (const c of cases) {
    const r = await pl.launch(c.req as any);
    console.log(c.label, '→', r.isErr ? `ERR: ${r.error.message}` : `OK pid=${r.value?.pid}`);
  }
}
main();
