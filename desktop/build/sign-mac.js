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
const NESTED = /\.(app|framework|dylib|node)$/;

function sign(target) {
  execFileSync('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', ENTITLEMENTS, target], { stdio: 'pipe' });
}

// depth-first: children before their parent bundle
function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, out);
    if (NESTED.test(name)) out.push(p);
  }
}

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  if (!fs.existsSync(app)) throw new Error(`sign-mac: ${app} not found`);
  const nested = [];
  walk(path.join(app, 'Contents', 'Frameworks'), nested);
  for (const t of nested) sign(t);
  sign(app);
  const ents = execFileSync('codesign', ['-d', '--entitlements', '-', app], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  if (!/com\.apple\.security\.device\.audio-input/.test(ents)) {
    throw new Error('sign-mac: Hannah.app is signed but the audio-input entitlement is missing');
  }
  console.log(`  • sign-mac: ${path.basename(app)} ad-hoc signed with mic/camera entitlements (${nested.length} nested items)`);
};
