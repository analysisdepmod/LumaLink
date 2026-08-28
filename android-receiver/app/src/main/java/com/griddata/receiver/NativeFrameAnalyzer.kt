package com.griddata.receiver

import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import kotlin.math.max

data class CaptureMetric(val fps: Int, val frameMs: Int, val width: Int, val height: Int)

/**
 * Zero-copy RGBA frame intake. This is the native replacement for browser
 * createImageBitmap/getImageData: it reads CameraX's latest frame on a bounded
 * executor, reports stable capture telemetry, and is the seam for the protocol
 * decoder (locator → cell sampler → LDPC) in subsequent native engine classes.
 */
class NativeFrameAnalyzer(private val report: (CaptureMetric) -> Unit) : ImageAnalysis.Analyzer {
    private var lastReportNs = 0L
    private var frames = 0

    override fun analyze(image: ImageProxy) {
        val started = System.nanoTime()
        try {
            val plane = image.planes[0]
            val buffer = plane.buffer
            // Touch a sparse luma sample while the decoder port is connected here;
            // this validates native RGBA access without allocating a frame-sized array.
            var checksum = 0
            val step = max(1, buffer.remaining() / 256)
            var i = 0
            while (i < buffer.remaining()) { checksum = checksum xor (buffer.get(i).toInt() and 0xFF); i += step }
            if (checksum == Int.MIN_VALUE) return // prevents the sampling work being optimised away
            frames++
            val now = System.nanoTime()
            if (now - lastReportNs >= 500_000_000L) {
                val elapsed = max(1L, now - lastReportNs)
                val fps = if (lastReportNs == 0L) 0 else (frames * 1_000_000_000L / elapsed).toInt()
                val ms = ((now - started) / 1_000_000L).toInt()
                report(CaptureMetric(fps, ms, image.width, image.height))
                lastReportNs = now
                frames = 0
            }
        } finally {
            image.close()
        }
    }
}
