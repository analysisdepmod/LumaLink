package com.griddata.griddata_receiver

import android.app.Activity
import android.content.Intent
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.android.FlutterActivity
import io.flutter.plugin.common.MethodChannel
import java.io.File

class MainActivity : FlutterActivity() {
    private val channelName = "com.griddata.griddata_receiver/files"
    private val saveRequestCode = 7001
    private var pendingResult: MethodChannel.Result? = null
    private var pendingSourcePath: String? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
            .setMethodCallHandler { call, result ->
                if (call.method != "saveCopy") {
                    result.notImplemented()
                    return@setMethodCallHandler
                }
                if (pendingResult != null) {
                    result.error("busy", "يوجد طلب حفظ مفتوح", null)
                    return@setMethodCallHandler
                }
                val sourcePath = call.argument<String>("sourcePath")
                val name = call.argument<String>("name") ?: "LumaLink-file"
                val mime = call.argument<String>("mime")?.takeIf { it.contains('/') }
                    ?: "application/octet-stream"
                if (sourcePath.isNullOrBlank() || !File(sourcePath).isFile) {
                    result.error("missing", "الملف المستلم غير موجود", null)
                    return@setMethodCallHandler
                }
                pendingResult = result
                pendingSourcePath = sourcePath
                val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = mime
                    putExtra(Intent.EXTRA_TITLE, name)
                }
                startActivityForResult(intent, saveRequestCode)
            }
    }

    @Deprecated("Deprecated in Android")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != saveRequestCode) return
        val result = pendingResult
        val sourcePath = pendingSourcePath
        pendingResult = null
        pendingSourcePath = null
        if (resultCode != Activity.RESULT_OK || data?.data == null) {
            result?.success(false)
            return
        }
        try {
            File(sourcePath!!).inputStream().use { input ->
                contentResolver.openOutputStream(data.data!!, "w").use { output ->
                    requireNotNull(output) { "تعذّر فتح مكان الحفظ" }
                    input.copyTo(output)
                }
            }
            result?.success(true)
        } catch (error: Exception) {
            result?.error("save_failed", error.message, null)
        }
    }
}
