package expo.modules.cellinfo

import android.os.Build
import android.telephony.CellInfo
import android.telephony.CellInfoCdma
import android.telephony.CellInfoGsm
import android.telephony.CellInfoLte
import android.telephony.CellInfoNr
import android.telephony.CellInfoTdscdma
import android.telephony.CellInfoWcdma
import android.telephony.CellIdentityNr
import android.telephony.CellSignalStrength
import android.telephony.CellSignalStrengthNr
import android.telephony.SubscriptionManager
import androidx.annotation.RequiresApi

/**
 * Converts Android [CellInfo] objects into plain, null-safe maps ready for JS.
 *
 * Android reports "unknown" numeric fields as [Integer.MAX_VALUE] (int) or
 * [Long.MAX_VALUE] (long). We normalize those — and blank MCC/MNC strings — to
 * `null` so JS never sees a 2147483647 sentinel.
 */
internal object CellInfoMapper {

  // CellInfo.UNAVAILABLE is API 29; use the raw constant to stay min-24 safe.
  private const val UNAVAILABLE_INT = Integer.MAX_VALUE
  private const val UNAVAILABLE_LONG = Long.MAX_VALUE

  fun map(cell: CellInfo, subId: Int): Map<String, Any?>? {
    // NR / TD-SCDMA identities only exist on API 29+. Guard the SDK check BEFORE
    // the `is` test so the class is never referenced on older runtimes.
    return when {
      cell is CellInfoLte -> mapLte(cell, base(cell, subId))
      cell is CellInfoGsm -> mapGsm(cell, base(cell, subId))
      cell is CellInfoWcdma -> mapWcdma(cell, base(cell, subId))
      @Suppress("DEPRECATION")
      cell is CellInfoCdma -> mapCdma(cell, base(cell, subId))
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && cell is CellInfoNr ->
        mapNr(cell, base(cell, subId))
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && cell is CellInfoTdscdma ->
        mapTdscdma(cell, base(cell, subId))
      else -> null // Unknown/unsupported radio type.
    }
  }

  /** Fields common to every cell. */
  private fun base(cell: CellInfo, subId: Int): MutableMap<String, Any?> = linkedMapOf(
    "registered" to cell.isRegistered,
    "subscriptionId" to if (subId == SubscriptionManager.INVALID_SUBSCRIPTION_ID) null else subId
  )

  // --- LTE --------------------------------------------------------------------

  private fun mapLte(cell: CellInfoLte, out: MutableMap<String, Any?>): Map<String, Any?> {
    val id = cell.cellIdentity
    val ss = cell.cellSignalStrength
    out["cellType"] = "LTE"
    out["ci"] = id.ci.orNull()
    out["pci"] = id.pci.orNull()
    out["tac"] = id.tac.orNull()
    out["earfcn"] = id.earfcn.orNull()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      out["bandwidth"] = id.bandwidth.orNull() // kHz, API 28+
      out["mcc"] = id.mccString.orNullString()
      out["mnc"] = id.mncString.orNullString()
    }
    out["timingAdvance"] = ss.timingAdvance.orNull()
    applySignal(out, ss)
    return out
  }

  // --- NR (5G) ----------------------------------------------------------------

  @RequiresApi(Build.VERSION_CODES.Q)
  private fun mapNr(cell: CellInfoNr, out: MutableMap<String, Any?>): Map<String, Any?> {
    val id = cell.cellIdentity as CellIdentityNr
    val ss = cell.cellSignalStrength as CellSignalStrengthNr
    out["cellType"] = "NR"
    out["nci"] = id.nci.orNull()       // long, up to 36-bit NCI
    out["pci"] = id.pci.orNull()
    out["tac"] = id.tac.orNull()
    out["nrarfcn"] = id.nrarfcn.orNull()
    out["mcc"] = id.mccString.orNullString()
    out["mnc"] = id.mncString.orNullString()
    // NR exposes dbm/asuLevel/level on CellSignalStrengthNr (also SS-RSRP etc,
    // omitted here for parity with the requested common fields).
    applySignal(out, ss)
    return out
  }

  // --- GSM --------------------------------------------------------------------

  private fun mapGsm(cell: CellInfoGsm, out: MutableMap<String, Any?>): Map<String, Any?> {
    val id = cell.cellIdentity
    val ss = cell.cellSignalStrength
    out["cellType"] = "GSM"
    out["cid"] = id.cid.orNull()
    out["lac"] = id.lac.orNull()
    out["arfcn"] = id.arfcn.orNull()   // API 24+
    out["bsic"] = id.bsic.orNull()     // API 24+
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      out["mcc"] = id.mccString.orNullString()
      out["mnc"] = id.mncString.orNullString()
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      out["timingAdvance"] = ss.timingAdvance.orNull() // API 26+
    }
    applySignal(out, ss)
    return out
  }

  // --- WCDMA ------------------------------------------------------------------

  private fun mapWcdma(cell: CellInfoWcdma, out: MutableMap<String, Any?>): Map<String, Any?> {
    val id = cell.cellIdentity
    val ss = cell.cellSignalStrength
    out["cellType"] = "WCDMA"
    out["cid"] = id.cid.orNull()
    out["lac"] = id.lac.orNull()
    out["psc"] = id.psc.orNull()
    out["uarfcn"] = id.uarfcn.orNull() // API 24+
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      out["mcc"] = id.mccString.orNullString()
      out["mnc"] = id.mncString.orNullString()
    }
    applySignal(out, ss)
    return out
  }

  // --- CDMA (legacy; deprecated by Android but still surfaced when present) ----

  @Suppress("DEPRECATION")
  private fun mapCdma(cell: CellInfoCdma, out: MutableMap<String, Any?>): Map<String, Any?> {
    val id = cell.cellIdentity
    val ss = cell.cellSignalStrength
    out["cellType"] = "CDMA"
    out["basestationId"] = id.basestationId.orNull()
    out["networkId"] = id.networkId.orNull()
    out["systemId"] = id.systemId.orNull()
    applySignal(out, ss)
    return out
  }

  // --- TD-SCDMA ---------------------------------------------------------------

  @RequiresApi(Build.VERSION_CODES.Q)
  private fun mapTdscdma(cell: CellInfoTdscdma, out: MutableMap<String, Any?>): Map<String, Any?> {
    val id = cell.cellIdentity
    val ss = cell.cellSignalStrength
    out["cellType"] = "TDSCDMA"
    out["cid"] = id.cid.orNull()
    out["lac"] = id.lac.orNull()
    out["cpid"] = id.cpid.orNull()     // cell parameters id
    out["uarfcn"] = id.uarfcn.orNull()
    out["mcc"] = id.mccString.orNullString()
    out["mnc"] = id.mncString.orNullString()
    applySignal(out, ss)
    return out
  }

  // --- Shared signal fields ---------------------------------------------------

  private fun applySignal(out: MutableMap<String, Any?>, ss: CellSignalStrength) {
    out["dbm"] = ss.dbm.orNull()
    out["asuLevel"] = ss.asuLevel.orNull()
    out["signalStrength"] = levelToString(ss.level)
  }

  /** Maps CellSignalStrength.getLevel() (0..4) to a human-readable bucket. */
  private fun levelToString(level: Int): String = when (level) {
    CellSignalStrength.SIGNAL_STRENGTH_NONE_OR_UNKNOWN -> "NONE_OR_UNKNOWN"
    CellSignalStrength.SIGNAL_STRENGTH_POOR -> "POOR"
    CellSignalStrength.SIGNAL_STRENGTH_MODERATE -> "MODERATE"
    CellSignalStrength.SIGNAL_STRENGTH_GOOD -> "GOOD"
    CellSignalStrength.SIGNAL_STRENGTH_GREAT -> "GREAT"
    else -> "NONE_OR_UNKNOWN"
  }

  // --- Sentinel → null helpers ------------------------------------------------

  private fun Int.orNull(): Int? = if (this == UNAVAILABLE_INT) null else this
  private fun Long.orNull(): Long? = if (this == UNAVAILABLE_LONG) null else this
  private fun String?.orNullString(): String? = if (this.isNullOrBlank()) null else this
}
