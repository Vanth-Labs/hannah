// electron-builder afterSign hook (macOS only). Ad-hoc signs Hannah.app WITH the mic/camera
// entitlements: electron-builder's own ad-hoc signature (identity "-") leaves them out, and
// without com.apple.security.device.audio-input macOS never shows the permission prompt, so
// Hannah is deaf with no error anywhere (see MACOS-FIXES.md in the workspace repo).
// Inside-out: nested helpers, frameworks, dylibs and .node first, the outer bundle last.
// No Apple account, no certificate: "-" is the ad-hoc identity.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ENTITLEMENTS = path.join(__dirname, 'entitlements.mac.plist');

function codesign(args, target) {
  try {
    execFileSync('codesign', [...args, target], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(`sign-mac: codesign failed on ${target}\n${(e.stderr || '').toString()}`);
  }
}

function list(dir, re) {
  try { return fs.readdirSync(dir).filter((n) => re.test(n)).map((n) => path.join(dir, n)); } catch { return []; }
}

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  if (!fs.existsSync(app)) throw new Error(`sign-mac: ${app} not found`);
  const fw = path.join(app, 'Contents', 'Frameworks');
  // 1) frameworks (Electron Framework and friends): --deep signs the dylibs and helpers they
  //    carry inside; frameworks carry no entitlements
  for (const f of list(fw, /\.framework$/)) codesign(['--force', '--deep', '--sign', '-', '--options', 'runtime'], f);
  // 2) helper apps (Hannah Helper (GPU/Renderer/Plugin).app): Chromium opens the audio device
  //    from these, so they need the same entitlements as the main app
  const helpers = list(fw, /\.app$/);
  for (const h of helpers) codesign(['--force', '--deep', '--sign', '-', '--options', 'runtime', '--entitlements', ENTITLEMENTS], h);
  // 3) the outer bundle, last
  codesign(['--force', '--sign', '-', '--options', 'runtime', '--entitlements', ENTITLEMENTS], app);
  for (const t of [app, ...helpers]) {
    const ents = execFileSync('codesign', ['-d', '--entitlements', '-', t], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    if (!/com\.apple\.security\.device\.audio-input/.test(ents)) throw new Error(`sign-mac: ${t} is signed but the audio-input entitlement is missing`);
  }
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: ['ignore', 'pipe', 'pipe'] });
  console.log(`  • sign-mac: ${path.basename(app)} + ${helpers.length} helpers ad-hoc signed with mic/camera entitlements`);
};
