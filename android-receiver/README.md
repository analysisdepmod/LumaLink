# GridData native receiver

Open `android-receiver` in Android Studio Hedgehog or newer, let Gradle fetch the
CameraX dependencies, then run it on the Huawei tablet. It uses CameraX RGBA
frames with `KEEP_ONLY_LATEST`, which avoids browser camera queues.

The current native module delivers the capture/analysis pipeline and telemetry.
The next engine step ports GridData's matrix locator, colour demodulator and LDPC
decoder into this native pipeline; it is deliberately kept separate from UI code.
