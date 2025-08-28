import React, { useCallback, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";

// Safely extract text if backend sometimes wraps a JSON string in another layer
function getMaskedText(mt) {
  try {
    if (typeof mt === "string") {
      const parsed = JSON.parse(mt);
      if (parsed && typeof parsed.text === "string") return parsed.text;
      return mt;
    }
    if (mt && typeof mt.text === "string") return mt.text;
    return "";
  } catch {
    return typeof mt === "string" ? mt : "";
  }
}

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";
// const API_URL = "http://192.168.0.237:8080";

export default function App() {
  const {
    register,
    handleSubmit,
    setValue,
    formState: { isSubmitting },
  } = useForm();

  const [file, setFile] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [status, setStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [rawJSON, setRawJSON] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [cardData, setCardData] = useState("");

  const dropRef = useRef(null);
  const pollStopRef = useRef(false);

  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      const f = e.dataTransfer.files?.[0];
      if (f) {
        setFile(f);
        // setFileAndPreview(f);
        setValue("file", [f], { shouldValidate: true, shouldDirty: true });
      }
    },
    [setValue]
  );

  useEffect(() => {
    const el = dropRef.current;
    if (!el) return;
    const prevent = (e) => e.preventDefault();
    el.addEventListener("dragover", prevent);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragover", prevent);
      el.removeEventListener("drop", onDrop);
    };
  }, [onDrop]);

  useEffect(() => {
    return () => {
      // stop polling on unmount
      pollStopRef.current = true;
      // setPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return ""; });
    };
  }, []);

  const onSubmit = async (data) => {
    setError(null);
    setResult(null);
    setRawJSON("");
    setStatus(null);
    setJobId(null);

    const chosen = (data?.file && data.file[0]) || file;
    if (!chosen) {
      setError("กรุณาเลือกไฟล์ภาพก่อน");
      return;
    }

    if (!/(image\/jpeg|image\/png)/.test(chosen.type)) {
      setError("รองรับเฉพาะไฟล์ JPG/PNG");
      return;
    }
    if (chosen.size > 10 * 1024 * 1024) {
      setError("ไฟล์ต้องไม่เกิน 10MB");
      return;
    }

    const form = new FormData();
    form.append("file", chosen);

    try {
      const res = await fetch(`${API_URL}/upload`, { method: "POST", body: form });
      const js = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(js?.error || "upload failed");

      // Show the immediate JSON we got back as a pretty string
      setRawJSON(JSON.stringify(js, null, 2));

      if (js?.jobId) {
        setJobId(js.jobId);
        setStatus("processing");
        pollStopRef.current = false;
        await pollStatus(js.jobId);
      } else {
        // If API returns the final result directly (no job), show it
        setStatus("done");
        setResult(js);
        setFileAndPreview(chosen)
        setCardData(JSON.parse(JSON.stringify(js, null, 2)))
        console.log(cardData)
      }
    } catch (e) {
      setStatus("failed");
      setError(e.message || "เกิดข้อผิดพลาดระหว่างอัปโหลด");
    }
  };

  const pollStatus = async (id) => {
    const start = Date.now();

    async function tick() {
      if (pollStopRef.current) return;
      try {
        const res = await fetch(`${API_URL}/status/${id}`);
        const js = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(js?.error || "status error");

        setStatus(js.status || "processing");

        if (js.status === "done") {
          setResult(js);
          setRawJSON(JSON.stringify(js, null, 2));
          return;
        }

        if (js.status === "error" || js.status === "rejected") {
          setError(js.error || js.status);
          return;
        }

        if (Date.now() - start > 120000) {
          setError("timeout");
          return;
        }

        setTimeout(tick, 1000);
      } catch (e) {
        setError(e.message || "status error");
      }
    }

    await tick();
  };

  const downloadJSON = () => {
    const data = result ?? rawJSON;
    if (!data) return;
    const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `result-${jobId ?? "now"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const maskedText = result ? getMaskedText(result.masked_text) : "";

  const setFileAndPreview = useCallback((f) => {
    setFile(f);
    if (f) {
      // setValue("file", [f], { shouldValidate: true, shouldDirty: true });
      setPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(f); });
    } else {
      // setValue("file", undefined);
      setPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return ""; });
    }
  }, [setValue]);

  return (
    <div className="flex flex-col gap-4 justify-center items-center mx-auto p-6">
      <h1 className="text-2xl font-semibold">SIRISOFT Optical Character Recognition (OCR)</h1>
      <p className="text-sm text-gray-600 mt-1">
        ขนาดไฟล์ ≤ 10MB • เฉพาะ JPG/PNG
      </p>

      <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4">
        <div
          ref={dropRef}
          className="border-2 border-dashed rounded-2xl p-8 text-center bg-white hover:bg-gray-50 cursor-pointer"
          onClick={() => document.getElementById("fileInput").click()}
        >
          <input
            id="fileInput"
            type="file"
            accept="image/png,image/jpeg"
            className="hidden"
            {...register("file", { required: true })}
            onChange={(e) => {
              const f = e.target.files?.[0] || null;
              setFile(f);
            }}
          />

          {file ? (
            <div className="text-sm">
              เลือกไฟล์: <span className="font-medium">{file.name}</span>
            </div>
          ) : (
            <div className="text-gray-500">วางไฟล์ที่นี่ หรือคลิกเพื่อเลือก</div>
          )}
        </div>
        <div className="flex gap-2 justify-center">
          <button
            disabled={isSubmitting || !file}
            className="px-4 py-2 bg-black text-white rounded-lg disabled:opacity-50"
          >
            อัปโหลดและประมวลผล
          </button>
          {rawJSON && (
            <button
              type="button"
              onClick={downloadJSON}
              className="px-4 py-2 border rounded-lg"
            >
              ดาวน์โหลดผลลัพธ์ JSON
            </button>
          )}
        </div>
      </form>

      <div className="mt-6 w-full max-w-3xl">
        {status && (
          <div className="text-sm">
            สถานะ: <span className="font-medium">{status}</span>
          </div>
        )}
        {error && <div className="mt-2 text-sm text-red-600">ข้อผิดพลาด: {error}</div>}

        {result && (
          <>
          {previewUrl && (
            <div className="w-full max-w-3xl mt-4">
            <div className="p-4 bg-white rounded-xl shadow">
            <div className="font-medium mb-2">ภาพต้นฉบับ</div>
            <div className="w-full flex justify-center">
            <img src={previewUrl} alt="uploaded-preview" className="max-h-[420px] w-auto object-contain rounded-lg" />
            </div>
            {jobId && (
            <div className="text-xs text-gray-500 mt-2">Job ID: <span className="font-mono">{jobId}</span></div>
            )}
            </div>
            </div>
          )}

          {/* {rawJSON && (
            <div className="mt-4 p-4 bg-white rounded-xl shadow">
              <div className="font-medium mb-2">ผลลัพธ์ JSON (Raw)</div>
              <pre className="text-sm overflow-auto whitespace-pre-wrap break-words">{rawJSON}</pre>
            </div>
          )} */}

          {cardData && (
            <div className="mt-4 p-4 bg-white rounded-xl shadow">
            <div className="font-medium mb-2">ข้อมูลบัตรประชาชน</div>
            <div className="grid grid-cols-1 gap-4 text-sm">
              <div className="flex items-center gap-2">
                <label className="w-40 text-gray-600">เลขบัตรประชาชน</label>
                <input
                  type="text"
                  defaultValue={cardData.id_card}
                  className="flex-1 px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-500"
                />
              </div>

              <div className="flex items-center gap-2">
                <label className="w-40 text-gray-600">คำนำหน้า (TH)</label>
                <input
                  type="text"
                  defaultValue={cardData.prefix_name_th}
                  className="flex-1 px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-500"
                />
              </div>

              <div className="flex items-center gap-2">
                <label className="w-40 text-gray-600">ชื่อ (TH)</label>
                <input
                  type="text"
                  defaultValue={cardData.first_name_th}
                  className="flex-1 px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-500"
                />
              </div>

              <div className="flex items-center gap-2">
                <label className="w-40 text-gray-600">นามสกุล (TH)</label>
                <input
                  type="text"
                  defaultValue={cardData.last_name_th}
                  className="flex-1 px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-500"
                />
              </div>

              <div className="flex items-center gap-2">
                <label className="w-40 text-gray-600">คำนำหน้า (EN)</label>
                <input
                  type="text"
                  defaultValue={cardData.prefix_name_en}
                  className="flex-1 px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-500"
                />
              </div>

              <div className="flex items-center gap-2">
                <label className="w-40 text-gray-600">ชื่อ (EN)</label>
                <input
                  type="text"
                  defaultValue={cardData.first_name_en}
                  className="flex-1 px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-500"
                />
              </div>

              <div className="flex items-center gap-2">
                <label className="w-40 text-gray-600">นามสกุล (EN)</label>
                <input
                  type="text"
                  defaultValue={cardData.last_name_en}
                  className="flex-1 px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-500"
                />
              </div>

              <div className="flex items-center gap-2">
                <label className="w-40 text-gray-600">วันเกิด (TH)</label>
                <input
                  type="text"
                  defaultValue={cardData.date_of_birth_th}
                  className="flex-1 px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-500"
                />
              </div>

              <div className="flex items-center gap-2">
                <label className="w-40 text-gray-600">วันเกิด (EN)</label>
                <input
                  type="text"
                  defaultValue={cardData.date_of_birth_en}
                  className="flex-1 px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-500"
                />
              </div>

              <div className="flex items-center gap-2">
                <label className="w-40 text-gray-600">วันหมดอายุ (TH)</label>
                <input
                  type="text"
                  defaultValue={cardData.date_of_expity_th}
                  className="flex-1 px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-500"
                />
              </div>

              <div className="flex items-center gap-2">
                <label className="w-40 text-gray-600">วันหมดอายุ (EN)</label>
                <input
                  type="text"
                  defaultValue={cardData.date_of_expity_en}
                  className="flex-1 px-3 py-2 border rounded-lg focus:outline-none focus:ring focus:border-blue-500"
                />
              </div>
            </div>
            </div>
          )}
          </>
        )}
      </div>
    </div>
  );
}
