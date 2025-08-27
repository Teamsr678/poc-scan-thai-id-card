import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'

function getMaskedText(mt) {
  try {
    if (typeof mt === 'string') {
      // Some backends return a JSON string like: "{\"text\": \"...\"}"
      const parsed = JSON.parse(mt);
      if (parsed && typeof parsed.text === 'string') return parsed.text;
      return mt; // plain text string
    }
    if (mt && typeof mt.text === 'string') return mt.text; // object form
    return '';
  } catch {
    // Not JSON, fallback to raw string
    return typeof mt === 'string' ? mt : '';
  }
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8080'

export default function App() {
  const { register, handleSubmit, setValue, formState: { isSubmitting } } = useForm()
  const [file, setFile] = useState(null)
  const [jobId, setJobId] = useState(null)
  const [status, setStatus] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const dropRef = useRef(null)

  const onDrop = useCallback((e) => {
    e.preventDefault()
    const f = e.dataTransfer.files?.[0]
    if (f) {
      setFile(f)
      setValue('file', f)
    }
  }, [setValue])

  useEffect(() => {
    const el = dropRef.current
    if (!el) return
    const prevent = (e) => e.preventDefault()
    el.addEventListener('dragover', prevent)
    el.addEventListener('drop', onDrop)
    return () => {
      el.removeEventListener('dragover', prevent)
      el.removeEventListener('drop', onDrop)
    }
  }, [onDrop])

  const onSubmit = async (data) => {
    setError(null)
    setResult(null)
    setStatus(null)
    setJobId(null)
    const form = new FormData()
    form.append('file', data.file[0] || file)
    try {
      const res = await fetch(`${API_URL}/upload`, { method: 'POST', body: form })
      const js = await res.json()
      if (!res.ok) throw new Error(js.error || 'upload failed')
      setJobId(js.jobId)
      setStatus('processing')
      pollStatus(js.jobId)
    } catch (e) {
      setError(e.message)
    }
  }

  const pollStatus = async (id) => {
    const t0 = Date.now()
    const tick = async () => {
      try {
        const res = await fetch(`${API_URL}/status/${id}`)
        const js = await res.json()
        if (!res.ok) throw new Error(js.error || 'status error')
        setStatus(js.status)
        if (js.status === 'done') {
          setResult(js.result)
          return
        }
        if (js.status === 'error' || js.status === 'rejected') {
          setError(js.error || js.status)
          return
        }
        if (Date.now() - t0 > 120000) {
          setError('timeout')
          return
        }
        setTimeout(tick, 1000)
      } catch (e) {
        setError(e.message)
      }
    }
    tick()
  }

  const downloadJSON = () => {
    if (!result) return
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `result-${jobId}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const maskedText = result ? getMaskedText(result.masked_text) : '';

  return (
    <div className="flex flex-col gap-4 justify-center items-center mx-auto p-6">
      <h1 className="text-2xl font-semibold">SIRISOFT AUCTION OCR</h1>
      <p className="text-sm text-gray-600 mt-1">ขนาดไฟล์ ≤ 10MB • เฉพาะ JPG/PNG • จะ reject ภาพเบลอ/ความละเอียดต่ำ</p>

      <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4">
        <div
          ref={dropRef}
          className="border-2 border-dashed rounded-2xl p-8 text-center bg-white hover:bg-gray-50 cursor-pointer"
          onClick={() => document.getElementById('fileInput').click()}
        >
          <input id="fileInput" type="file" accept="image/png,image/jpeg" className="hidden" {...register('file', { required: true })} onChange={(e) => setFile(e.target.files?.[0])} />
          {file
            ? <div className="text-sm">เลือกไฟล์: <span className="font-medium">{file.name}</span></div>
            : <div className="text-gray-500">วางไฟล์ที่นี่ หรือคลิกเพื่อเลือก</div>
          }
        </div>
        <div className="flex gap-2">
          <button disabled={isSubmitting || !file} className="px-4 py-2 bg-black text-white rounded-lg disabled:opacity-50">อัปโหลดและประมวลผล</button>
          <a href={`${API_URL}/file/${jobId}`} target="_blank" className="px-4 py-2 border rounded-lg">ดาวน์โหลดไฟล์ต้นฉบับ</a>
          {result && <button type="button" onClick={downloadJSON} className="px-4 py-2 border rounded-lg">ดาวน์โหลดผลลัพธ์ JSON</button>}
        </div>
      </form>

      <div className="mt-6">
        {status && <div className="text-sm">สถานะ: <span className="font-medium">{status}</span></div>}
        {error && <div className="mt-2 text-sm text-red-600">ข้อผิดพลาด: {error}</div>}
        {result && (
          <div className="mt-4 grid gap-4">
            <div className="p-4 bg-white rounded-xl shadow">
              <div className="font-medium mb-2">ผลลัพท์ข้อมูล</div>
              <div className="text-sm space-y-3">
                {maskedText
                  .split(/\n\s*\n/) // split by blank line
                  .map((para, i) => (
                    <p key={i} className="whitespace-pre-wrap break-words">{para.trim()}</p>
                  ))}
              </div>
            </div>
            <div className="p-4 bg-white rounded-xl shadow">
              <div className="font-medium mb-2">Normalized JSON</div>
              <pre className="text-sm overflow-auto">{JSON.stringify(result.json, null, 2)}</pre>
            </div>
            <div className="p-4 bg-white rounded-xl shadow">
              <div className="font-medium mb-2">Validation</div>
              <pre className="text-sm overflow-auto">{JSON.stringify(result.validation, null, 2)}</pre>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
