"""藍新 ezPay 電子發票 client.

Mirrors the shape of ``line_client.py``: URL constants, an env-gated
mock mode, a custom ``EzpayError`` carrying a zh-TW ``friendly_message``,
and async functions that take the shared ``httpx.AsyncClient``.

ezPay request encoding (the load-bearing detail):
  body = application/x-www-form-urlencoded with exactly
    MerchantID_ = <merchant id>
    PostData_   = hex( AES-256-CBC-PKCS7( urlencode(params), HashKey, HashIV ) )
  PostData_ is HEX (bin2hex), NOT base64 — the single most common bug.
  HashKey is 32 chars → AES-256; HashIV is 16 chars; both used as raw
  ASCII key/iv bytes.

Response (RespondType=JSON) is plaintext JSON:
  {"Status": "SUCCESS", "Message": "...", "Result": "<json string>"}
Result is a JSON *string* → json.loads → InvoiceNumber / RandomNum /
MerchantOrderNo / InvoiceTransNo / CheckCode.
"""

import json as _json
from typing import Any, Optional
from urllib.parse import urlencode

import httpx
from cryptography.hazmat.primitives import padding as _sym_padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

# API paths (relative to the base host). invoice_issue Version 1.5.
ISSUE_PATH = "/Api/invoice_issue"
VOID_PATH = "/Api/invoice_invalid"
ALLOWANCE_PATH = "/Api/allowance_issue"

ISSUE_VERSION = "1.5"
VOID_VERSION = "1.0"


class EzpayError(RuntimeError):
    """A failed ezPay call. ``friendly_message`` is an operator-facing
    zh-TW string safe to surface in a toast / stored as last_error."""

    def __init__(self, status: str, detail: str):
        self.status = status
        self.detail = detail
        self.friendly_message = _translate_ezpay_error(status, detail)
        super().__init__(f"ezPay {status}: {detail}")


# Common ezPay 電子發票 API error codes → zh-TW. Unmapped codes fall
# back to the raw ezPay Message (already Chinese for most codes).
_ERROR_HINTS = {
    "10004": "資料解密錯誤(多半是 HashKey / HashIV 設定不符,或 PostData 編碼錯誤)。",
    "10005": "商店未啟用電子發票服務,請確認 ezPay 後台設定。",
    "IN10005": "此自訂訂單編號已使用過,請重新開立(訂單編號不可重複)。",
    "IN10015": "統一編號格式錯誤。",
}


def _translate_ezpay_error(status: str, detail: str) -> str:
    hint = _ERROR_HINTS.get(str(status).strip())
    base = f"電子發票開立失敗(ezPay {status})"
    if hint:
        return f"{base}:{hint}"
    return f"{base}:{detail}" if detail else base


def _mock_enabled(mock_flag: Any) -> bool:
    return str(mock_flag).strip().lower() in ("1", "true", "yes", "on")


def _validate_creds(hash_key: str, hash_iv: str) -> None:
    if len(hash_key) != 32 or len(hash_iv) != 16:
        raise EzpayError(
            "CONFIG",
            "EZPAY_HASH_KEY 需 32 碼、EZPAY_HASH_IV 需 16 碼,請檢查商店金鑰。",
        )


def encrypt(param_str: str, hash_key: str, hash_iv: str) -> str:
    """AES-256-CBC + PKCS7, hex-encoded (lowercase)."""
    padder = _sym_padding.PKCS7(128).padder()
    data = padder.update(param_str.encode("utf-8")) + padder.finalize()
    enc = Cipher(
        algorithms.AES(hash_key.encode("utf-8")), modes.CBC(hash_iv.encode("utf-8"))
    ).encryptor()
    return (enc.update(data) + enc.finalize()).hex()


def decrypt(hex_str: str, hash_key: str, hash_iv: str) -> str:
    raw = bytes.fromhex(hex_str)
    dec = Cipher(
        algorithms.AES(hash_key.encode("utf-8")), modes.CBC(hash_iv.encode("utf-8"))
    ).decryptor()
    padded = dec.update(raw) + dec.finalize()
    unpadder = _sym_padding.PKCS7(128).unpadder()
    return (unpadder.update(padded) + unpadder.finalize()).decode("utf-8")


async def _post(
    client: httpx.AsyncClient,
    *,
    base: str,
    path: str,
    merchant_id: str,
    hash_key: str,
    hash_iv: str,
    params: dict,
    timestamp: int,
    version: str,
    mock: Any = "0",
) -> dict:
    """Envelope + encrypt + POST + parse. Returns the decoded ``Result``
    dict. Raises ``EzpayError`` on any non-SUCCESS status."""
    full = {
        "RespondType": "JSON",
        "Version": version,
        "TimeStamp": str(timestamp),
        **{k: v for k, v in params.items() if v not in (None, "")},
    }
    param_str = urlencode(full)

    # Mock (or unconfigured) → print the decrypted params + return a
    # synthetic success so the full issue → persist → UI pipeline runs
    # without credentials or a real ezPay call.
    if _mock_enabled(mock) or not (merchant_id and hash_key and hash_iv):
        print(f"[ezpay:MOCK] {path} params: {param_str}", flush=True)
        return {
            "_mock": True,
            "MerchantOrderNo": params.get("MerchantOrderNo", ""),
            "InvoiceNumber": "AB00000001",
            "RandomNum": "1234",
            "TotalAmt": params.get("TotalAmt"),
            "InvoiceTransNo": f"MOCK{timestamp}",
            "CheckCode": "MOCK",
        }

    _validate_creds(hash_key, hash_iv)
    post_data = encrypt(param_str, hash_key, hash_iv)
    try:
        resp = await client.post(
            f"{base}{path}",
            data={"MerchantID_": merchant_id, "PostData_": post_data},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            # 15s: return our own error before the platform gateway 504s a
            # slow/unreachable ezPay host (which the UI shows as a generic
            # 「伺服器暫時無法回應」instead of the real reason).
            timeout=15.0,
        )
    except httpx.TimeoutException as exc:
        raise EzpayError("TIMEOUT", "ezPay 逾時未回應,請稍後重試") from exc
    except httpx.HTTPError as exc:
        raise EzpayError("HTTP", f"連線 ezPay 失敗:{exc!r}") from exc

    try:
        body = resp.json()
    except Exception as exc:  # noqa: BLE001 — any non-JSON body is fatal
        raise EzpayError("HTTP", f"{resp.status_code} 非預期回應(非 JSON)") from exc

    status = str(body.get("Status") or "")
    if status != "SUCCESS":
        raise EzpayError(status or "ERROR", str(body.get("Message") or "未知錯誤"))

    result_raw = body.get("Result")
    if isinstance(result_raw, str):
        try:
            return _json.loads(result_raw)
        except Exception:
            return {"_raw": result_raw}
    return result_raw if isinstance(result_raw, dict) else {}


async def issue_invoice(
    client: httpx.AsyncClient,
    *,
    base: str,
    merchant_id: str,
    hash_key: str,
    hash_iv: str,
    params: dict,
    timestamp: int,
    mock: Any = "0",
) -> dict:
    """Issue an invoice (即時開立, Status=1). ``params`` carries the
    invoice-specific fields (Category / BuyerName / Amt / TaxAmt /
    TotalAmt / Item* / ...). Returns the decoded Result (InvoiceNumber,
    RandomNum, ...)."""
    return await _post(
        client,
        base=base,
        path=ISSUE_PATH,
        merchant_id=merchant_id,
        hash_key=hash_key,
        hash_iv=hash_iv,
        params=params,
        timestamp=timestamp,
        version=ISSUE_VERSION,
        mock=mock,
    )


async def invalidate_invoice(
    client: httpx.AsyncClient,
    *,
    base: str,
    merchant_id: str,
    hash_key: str,
    hash_iv: str,
    invoice_number: str,
    reason: str,
    timestamp: int,
    mock: Any = "0",
) -> dict:
    """作廢 an already-issued invoice (``/Api/invoice_invalid``, Version 1.0).
    ``invoice_number`` is the ezPay 發票號碼; ``reason`` the 作廢原因. Returns
    the decoded Result (InvoiceNumber, CreateTime)."""
    return await _post(
        client,
        base=base,
        path=VOID_PATH,
        merchant_id=merchant_id,
        hash_key=hash_key,
        hash_iv=hash_iv,
        params={"InvoiceNumber": invoice_number, "InvalidReason": reason},
        timestamp=timestamp,
        version=VOID_VERSION,
        mock=mock,
    )
