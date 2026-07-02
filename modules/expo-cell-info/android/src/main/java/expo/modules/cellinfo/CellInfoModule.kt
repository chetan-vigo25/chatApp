package expo.modules.cellinfo

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/**
 * Options accepted by [getAllCellInfo]. Modeled as an Expo [Record] so the JS
 * object is validated/typed at the bridge before it reaches Kotlin.
 */
class GetCellInfoOptions : Record {
  /**
   * When false (default) only the currently-registered serving cell(s) are
   * returned. When true, neighboring (non-serving) cells are included too.
   */
  @Field
  var includeNeighbors: Boolean = false
}

// --- Typed, coded errors surfaced to JS (each maps to a stable `code`) --------

internal class MissingContextException :
  CodedException("The Android context is unavailable; is the app fully initialized?")

internal class MissingPermissionException :
  CodedException(
    "ACCESS_FINE_LOCATION has not been granted. It is required to read cell info " +
      "on Android 10+. Call requestPermissionsAsync() first."
  )

internal class NoTelephonyException :
  CodedException("This device has no telephony (cellular) service available.")

class CellInfoModule : Module() {

  private val context: Context
    get() = appContext.reactContext ?: throw MissingContextException()

  override fun definition() = ModuleDefinition {
    // JS: requireNativeModule("CellInfoModule")
    Name("CellInfoModule")

    // Read cell info. Runs on a background queue because getAllCellInfo() can
    // block briefly while the modem is polled.
    AsyncFunction("getAllCellInfo") { options: GetCellInfoOptions ->
      ensureLocationPermission()
      readCellInfo(includeNeighbors = options.includeNeighbors)
    }.runOnQueue(Queues.DEFAULT)

    // Synchronous-ish helper: true when FINE location is already granted.
    Function("hasPermissions") {
      hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)
    }

    // Native permission flow. Requests ONLY ACCESS_FINE_LOCATION — the single
    // permission getAllCellInfo() actually requires. READ_PHONE_STATE (used only
    // to enumerate per-SIM managers on dual-SIM devices) is intentionally NOT
    // bundled here: Expo's permission manager returns granted=true only if EVERY
    // requested permission is granted, so folding in the optional phone-state
    // permission made `granted` read false even when location was allowed.
    // Dual-SIM still works opportunistically when the app already holds
    // READ_PHONE_STATE (see collectTelephonyManagers); request it separately via
    // requestPhoneStatePermissionsAsync() if you need it.
    AsyncFunction("getPermissionsAsync") { promise: Promise ->
      Permissions.getPermissionsWithPermissionsManager(
        appContext.permissions,
        promise,
        Manifest.permission.ACCESS_FINE_LOCATION
      )
    }

    AsyncFunction("requestPermissionsAsync") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(
        appContext.permissions,
        promise,
        Manifest.permission.ACCESS_FINE_LOCATION
      )
    }

    // Optional: request READ_PHONE_STATE for more reliable dual-SIM enumeration.
    // Not needed for basic getAllCellInfo(); call only if you want per-SIM data.
    AsyncFunction("requestPhoneStatePermissionsAsync") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(
        appContext.permissions,
        promise,
        Manifest.permission.READ_PHONE_STATE
      )
    }
  }

  // --- Permission helpers -----------------------------------------------------

  private fun hasPermission(permission: String): Boolean =
    ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

  private fun ensureLocationPermission() {
    if (!hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) {
      throw MissingPermissionException()
    }
  }

  // --- Core read --------------------------------------------------------------

  private fun readCellInfo(includeNeighbors: Boolean): List<Map<String, Any?>> {
    val defaultTm = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
      ?: throw NoTelephonyException()

    // Wi-Fi-only / no-SIM devices report PHONE_TYPE_NONE — return empty rather
    // than error so JS can simply render "no cellular".
    if (defaultTm.phoneType == TelephonyManager.PHONE_TYPE_NONE) {
      return emptyList()
    }

    val results = mutableListOf<Map<String, Any?>>()
    val seen = HashSet<String>()

    // On dual-SIM devices the default manager usually already returns cells for
    // every radio, but querying each active subscription's manager is more
    // reliable across OEMs. We dedupe below to avoid double-counting.
    for ((subId, tm) in collectTelephonyManagers(defaultTm)) {
      val cells = try {
        tm.allCellInfo // may be null on some devices / permission edge cases
      } catch (e: SecurityException) {
        // Location revoked between our check and the modem call.
        throw MissingPermissionException()
      } ?: continue

      for (cell in cells) {
        // Requirement #9: default to the serving cell only.
        if (!includeNeighbors && !cell.isRegistered) continue

        val mapped = CellInfoMapper.map(cell, subId) ?: continue
        if (seen.add(dedupeKey(mapped))) {
          results.add(mapped)
        }
      }
    }

    // Serving cell(s) first, then neighbors — stable, predictable ordering.
    return results.sortedByDescending { it["registered"] as? Boolean ?: false }
  }

  /**
   * Returns (subscriptionId -> TelephonyManager) pairs to query. When
   * READ_PHONE_STATE is granted and multiple SIMs are active, one manager per
   * subscription is returned (dual-SIM). Otherwise falls back to the default
   * manager with an INVALID subscription id.
   */
  private fun collectTelephonyManagers(default: TelephonyManager): List<Pair<Int, TelephonyManager>> {
    val managers = mutableListOf<Pair<Int, TelephonyManager>>()

    if (hasPermission(Manifest.permission.READ_PHONE_STATE)) {
      val sm = context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE) as? SubscriptionManager
      val subs = try {
        sm?.activeSubscriptionInfoList
      } catch (e: SecurityException) {
        null
      }
      subs?.forEach { info ->
        val subId = info.subscriptionId
        managers.add(subId to default.createForSubscriptionId(subId))
      }
    }

    if (managers.isEmpty()) {
      managers.add(SubscriptionManager.INVALID_SUBSCRIPTION_ID to default)
    }
    return managers
  }

  /** Stable identity of a cell (independent of fluctuating signal) for dedupe. */
  private fun dedupeKey(cell: Map<String, Any?>): String {
    val id = cell["ci"] ?: cell["cid"] ?: cell["nci"] ?: cell["basestationId"] ?: "?"
    val secondary = cell["pci"] ?: cell["psc"] ?: cell["networkId"] ?: "?"
    return "${cell["cellType"]}:${cell["subscriptionId"]}:$id:$secondary"
  }
}
