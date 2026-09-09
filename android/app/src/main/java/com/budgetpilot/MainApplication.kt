package com.budgetpilot

import android.app.Application
import cl.json.ShareApplication
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication, ShareApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Lokales natives Modul (nicht per npm autolinked) — Android-
          // Gegenstück zu ios/budgetpilot/ReceiptOCR.swift.
          add(ReceiptOCRPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }

  // Von react-native-share benötigt, um beim Teilen einer lokalen Datei
  // (siehe pdfExport.ts) einen content://-Link über den in AndroidManifest.xml
  // registrierten FileProvider zu erzeugen statt eines rohen file://-Pfads.
  override fun getFileProviderAuthority(): String = "${packageName}.provider"
}
