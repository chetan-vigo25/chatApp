/**
 * Is this Mac's LEGACY (usbmuxd/lockdown) pairing with the wired iPhone still valid?
 *
 * `npx expo run:ios` installs through Expo's own JS implementation of Apple's
 * usbmux/lockdown protocol, NOT through Xcode's devicectl. That path needs a
 * pair record whose HostID the device still trusts. When the device stops
 * recognising it, lockdownd answers `InvalidHostID` and Expo dies at
 * "› Installing …" — even though Xcode/devicectl keep working, because
 * CoreDevice pairing is a completely separate record.
 *
 * This runs the exact same handshake Expo does, so you can tell whether a
 * re-pair actually fixed it without waiting for a full rebuild.
 *
 *   node scripts/ios-pairing-check.js
 */
const path = require('path');
const base = path.join(__dirname, '..', 'node_modules/expo/node_modules/@expo/cli/build/src/run/ios/appleDevice/client');
const { UsbmuxdClient } = require(`${base}/UsbmuxdClient`);
const { LockdowndClient } = require(`${base}/LockdowndClient`);

const sock = () => UsbmuxdClient.connectUsbmuxdSocket();

(async () => {
  const devices = await new UsbmuxdClient(sock()).getDevices();
  if (!devices.length) {
    console.log('✗ usbmuxd sees no device. Plug the iPhone in and unlock it.');
    process.exit(1);
  }
  for (const device of devices) {
    const udid = device.Properties.SerialNumber;
    console.log(`device ${udid} (${device.Properties.ConnectionType})`);

    const record = await new UsbmuxdClient(sock()).readPairRecord(udid);
    console.log(`  pair record HostID: ${record.HostID}`);

    const lockdown = new LockdowndClient(await new UsbmuxdClient(sock()).connect(device, 62078));
    console.log(`  lockdownd reachable: ${await lockdown.queryType()}`);
    try {
      await lockdown.startSession(record);
      console.log('  ✓ StartSession OK — `npx expo run:ios` can install on this device');
    } catch (e) {
      console.log(`  ✗ StartSession failed: ${e.message}`);
      if (String(e.message).includes('InvalidHostID')) {
        console.log('    The device no longer trusts this HostID. Re-pair:');
        console.log('      iPhone → Settings → General → Transfer or Reset iPhone →');
        console.log('      Reset → Reset Location & Privacy, then replug and tap Trust.');
        console.log('    Until then use ./scripts/ios-device.sh (devicectl) to install.');
      }
    }
  }
  process.exit(0);
})().catch((e) => { console.log('FATAL', e.message); process.exit(1); });
