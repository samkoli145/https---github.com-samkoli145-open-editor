#!/usr/bin/env node
import { bootNawat, PROFILES, type ProfileName } from '../src/index';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'boot';

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(`
Nawat Kernel Host CLI (Open Editor Kernel)
------------------------------------------
Usage:
  nawat boot [--profile=editor|agent|hermes|headless]
  nawat status
  nawat profiles
  nawat help
    `);
    process.exit(0);
  }

  if (command === 'profiles') {
    console.log('\nAvailable Profiles:');
    Object.values(PROFILES).forEach((p) => {
      console.log(`  - ${p.name.padEnd(10)} : ${p.title.ar} / ${p.title.en}`);
    });
    console.log('');
    process.exit(0);
  }

  const profileArg = args.find((a) => a.startsWith('--profile='));
  const profileName: ProfileName = profileArg
    ? (profileArg.split('=')[1] as ProfileName)
    : 'editor';

  console.log(`[Nawat Host] Booting kernel with profile: '${profileName}'...`);
  const bootResult = await bootNawat({ profile: profileName });

  if (!bootResult.isOk) {
    console.error(`[Nawat Host] Boot failed: ${bootResult.error.message}`);
    process.exit(1);
  }

  const runtime = bootResult.value;
  const metrics = runtime.getMetrics();
  const ctx = runtime.getContext();

  console.log(`[Nawat Host] Boot success in ${metrics.bootTimeMs}ms! State: ${runtime.getState()}`);
  console.log(`[Nawat Host] Active Commands: ${ctx.commands.list().length}`);
  console.log(`[Nawat Host] Signaling Latency: ${metrics.signalingLatencyMs}ms (Budget <= 10ms)`);

  if (command === 'status') {
    console.log(JSON.stringify(runtime.getMetrics(), null, 2));
    await runtime.shutdown();
    process.exit(0);
  }

  // Handle termination signals
  const cleanup = async () => {
    console.log('\n[Nawat Host] Shutting down cleanly...');
    await runtime.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch((err) => {
  console.error('[Nawat Host] Fatal error:', err);
  process.exit(1);
});
