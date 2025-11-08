import 'dotenv/config';
import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import cors from "cors"; 

// --- Configuration Setup ---
const PORT = process.env.PORT || 4000; 

const {
  PUBLIC_BASE_URL,
  WAVESPEED_API_KEY,
  FAL_API_TOKEN, 
  AIRTABLE_PAT,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE
} = process.env;

// Check for required environment variables
if (!PUBLIC_BASE_URL || !WAVESPEED_API_KEY || !AIRTABLE_PAT || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE || !FAL_API_TOKEN) {
  console.error("❌ Missing required env vars. Ensure all API keys and PUBLIC_BASE_URL are set.");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

// const sleep = (ms) => new Promise(r => setTimeout(r, ms)); // Removed for faster submission
const nowISO = () => new Date().toISOString();

// ---------- Airtable Functions ----------
const baseURL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}`;
const headers = { Authorization: `Bearer ${AIRTABLE_PAT}`, "Content-Type": "application/json" };

async function createRow(fields) {
  const res = await fetch(baseURL, { method: "POST", headers, body: JSON.stringify({ records: [{ fields }] }) });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Airtable create failed: ${res.status} ${txt}`);
  const data = JSON.parse(txt);
  return data.records?.[0]?.id;
}

async function patchRow(id, fields) {
  const res = await fetch(`${baseURL}/${id}`, { method: "PATCH", headers, body: JSON.stringify({ fields }) });
  if (!res.ok) throw new Error(`Airtable patch ${res.status}: ${await res.text()}`);
}

async function getRow(recordId) {
  const res = await fetch(`${baseURL}/${recordId}`, { headers });
  if (!res.ok) throw new Error(`Airtable get failed: ${res.status}`);
  return res.json();
}

async function urlToDataURL(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get("content-type") || "image/png";
  return `data:${type};base64,${buf.toString("base64")}`;
}

// ---------- WaveSpeed Submission ----------
// FIX: Added 'prompt' to the destructured parameters to prevent ReferenceError
async function submitWaveSpeedJob({ prompt, subjectDataUrl, referenceDataUrls, width, height, runId, recordId }) {
    
    const modelPath = "bytedance/seedream-v4"; 
    const simplifiedModelName = "bytedance/seedream-v4"; 
    const allImages = (subjectDataUrl ? [subjectDataUrl] : []).concat(referenceDataUrls || []);

    const payload = {
        prompt, // ReferenceError fixed here
        model: simplifiedModelName, 
        width: Number(width) || 1024,
        height: Number(height) || 1024,
        images: allImages, 
    };

    const webhook = `${PUBLIC_BASE_URL.replace(/\/+$/, "")}/webhooks/wavespeed?record_id=${encodeURIComponent(recordId)}&run_id=${encodeURIComponent(runId)}`;
    const url = `https://api.wavespeed.ai/api/v3/${modelPath}`; 

    const res = await fetch(`${url}?webhook=${encodeURIComponent(webhook)}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${WAVESPEED_API_KEY}`, 
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    });

    const txt = await res.text();
    
    if (!res.ok) {
        console.error(`❌ WaveSpeed submit error (Status ${res.status}): ${txt}`);
        let errorMessage = `WaveSpeed API Error (${res.status}): `;
        try {
            const data = JSON.parse(txt);
            errorMessage += data.message || txt;
        } catch {
            errorMessage += txt;
        }
        throw new Error(errorMessage);
    }
    
    const responseData = JSON.parse(txt);
    const jobData = responseData.data || {}; 
    const requestId = jobData.id || jobData.request_id || jobData.task_id || null; 
    
    if (!requestId) {
        console.error("❌ WaveSpeed submit: no id in response, body was:", txt);
        throw new Error("WaveSpeed submit: no id in response");
    }

    console.log(`🚀 WaveSpeed job submitted: ${requestId}`);
    return requestId;
}

// ---------- FAL Submission ----------
// FIX: Added 'prompt' to the destructured parameters to prevent ReferenceError
async function submitFalJob({ prompt, subjectUrl, width, height, runId, recordId }) {
    
    const modelId = "fal-ai/stable-diffusion-xl"; 
    const imageInput = subjectUrl || null; 

    const webhook = `${PUBLIC_BASE_URL.replace(/\/+$/, "")}/webhooks/fal?record_id=${encodeURIComponent(recordId)}&run_id=${encodeURIComponent(runId)}`;

    const payload = {
        prompt, // ReferenceError fixed here
        image_url: imageInput, 
        width: Number(width) || 1024,
        height: Number(height) || 1024,
    };
    
    // URL FIX: Includes /v1/ to fix the 404 error
    const url = `https://api.fal.ai/v1/models/${modelId}/generate?webhook=${encodeURIComponent(webhook)}`;

    // DEBUG: Log the token value before use to isolate the 401 error cause
    console.log("DEBUG: Fal Token Value (Length):", FAL_API_TOKEN ? FAL_API_TOKEN.length : 'undefined');

    const res = await fetch(url, {
        method: "POST",
        headers: {
            // Header is correct: uses 'Key ' prefix
            Authorization: `Key ${FAL_API_TOKEN}`, 
            "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
    });

    const txt = await res.text();
    
    if (!res.ok) {
        console.error(`❌ Fal submit error (Status ${res.status}): ${txt}`);
        let errorMessage = `Fal API Error (${res.status}): `;
        try {
            const data = JSON.parse(txt);
            errorMessage += data.detail || data.error || txt;
        } catch {
            errorMessage += txt;
        }
        throw new Error(errorMessage);
    }
    
    const responseData = JSON.parse(txt);
    const requestId = responseData.request_id || responseData.id || null; 
    
    if (!requestId) {
        console.error("❌ Fal submit: no id in response, body was:", txt);
        throw new Error("Fal submit: no id in response");
    }

    console.log(`🚀 Fal job submitted: ${requestId}`);
    return requestId;
}


// ---------- UI (Includes Provider Select) ----------
app.get("/app", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Provider Dashboard</title>
<style>
body{
  margin:0;padding:40px;
  font-family:Segoe UI,Roboto,sans-serif;
  background:linear-gradient(135deg,#101820,#06131f);
  color:#f5f5f5;
}
h1{text-align:center;color:#00bcd4;margin-bottom:30px;}
form{
  max-width:720px;margin:auto;
  background:rgba(255,255,255,0.05);
  padding:24px;border-radius:16px;
  box-shadow:0 8px 24px rgba(0,0,0,0.4);
  backdrop-filter:blur(12px);
  transition:transform .2s ease;
}
form:hover{transform:translateY(-3px);}
label{display:block;margin-top:14px;font-weight:600;color:#80deea;}
input,textarea,select{
  width:100%;padding:10px;margin-top:6px;
  border:none;border-radius:8px;
  background:rgba(255,255,255,0.1);
  color:#fff;font-size:14px;transition:.3s;
  appearance: none; 
  background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="rgba(255,255,255,0.7)" d="M7 10l5 5 5-5z"/></svg>');
  background-repeat: no-repeat;
  background-position: right 10px center;
  padding-right: 30px;
}
input:focus,textarea:focus,select:focus{background:rgba(255,255,255,0.2);outline:none;}
button{
  margin-top:20px;padding:14px;width:100%;
  border:none;border-radius:12px;
  background:#00bcd4;color:#fff;
  font-size:16px;font-weight:600;cursor:pointer;
  transition:.3s;
}
button:hover{background:#0097a7;box-shadow:0 0 12px rgba(0,188,212,.5);}
#loading{display:none;text-align:center;margin-top:20px;}
</style>
</head>
<body>
<h1>⚡ Multi-Provider Runner (WaveSpeed/Fal)</h1>
<form id="batchForm">
  <label>Provider</label>
  <select name="provider">
    <option value="WaveSpeed">WaveSpeed (Seedream v4)</option>
    <option value="Fal">Fal (Stable Diffusion XL)</option>
  </select>

  <label>Prompt</label>
  <textarea name="prompt" rows="3" required placeholder="Describe your dream image..."></textarea>
  <label>Subject image URL (Optional)</label>
  <input name="subjectUrl" type="url" placeholder="https://example.com/subject.png">
  <label>Reference image URLs (comma-separated, Optional - Used by WaveSpeed only)</label>
  <input name="referenceUrls" type="text" placeholder="https://ref1.png, https://ref2.png">
  <div style="display:flex;gap:10px;margin-top:10px;">
    <div style="flex:1"><label>Width</label><input name="width" type="number" value="1024"></div>
    <div style="flex:1"><label>Height</label><input name="height" type="number" value="1024"></div>
  </div>
  <label>Batch count</label><input name="count" type="number" value="1" min="1" max="10">
  <button type="submit">🚀 Start Batch</button>
</form>
<div id="loading">Submitting batch... please wait ⏳</div>
<script>
const form=document.getElementById('batchForm');
const loading=document.getElementById('loading');
form.addEventListener('submit',async e=>{
  e.preventDefault();
  loading.style.display='block';
  const data=new URLSearchParams(new FormData(form));
  const res=await fetch('/api/start-batch',{method:'POST',body:data});
  const json=await res.json();
  loading.innerHTML='<pre style="text-align:left;background:#000;padding:12px;border-radius:8px;">'+JSON.stringify(json,null,2)+'</pre>';
});
</script>
</body></html>`);
});

// ---------- API (CENTRAL DISPATCHER) ----------
app.post("/api/start-batch", async (req, res) => {
  try {
    const { prompt, subjectUrl = "", referenceUrls = "", width = 1024, height = 1024, count = 1 } = req.body;
    const provider = String(req.body.provider || 'WaveSpeed').trim();
    
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const refs = referenceUrls.split(",").map(s => s.trim()).filter(Boolean);
    const runId = crypto.randomUUID();
    
    // 1. Prepare job data based on provider
    let submissionData = {
        prompt, width, height, runId, subjectUrl, recordId: null
    };

    let modelName = "";
    let dataUrls = null; 
    
    if (provider === 'WaveSpeed') {
        dataUrls = {
            subjectDataUrl: subjectUrl ? await urlToDataURL(subjectUrl) : null,
            referenceDataUrls: await Promise.all(refs.map(urlToDataURL)),
        };
        modelName = "WaveSpeed (Seedream v4)";
    } else if (provider === 'Fal') {
        modelName = "Fal (Stable Diffusion XL)";
    } else {
        return res.status(400).json({ error: "Invalid provider selected" });
    }

    // 2. Create the row in Airtable
    const recordId = await createRow({
      "Provider": provider,
      "Prompt": prompt,
      "Subject": subjectUrl ? [{ url: subjectUrl }] : [],
      "References": refs.map(u => ({ url: u })),
      "Model": modelName, 
      "Size": `${width}x${height}`,
      "Status": "pending", 
      "Run ID": runId,
      "Created At": nowISO(),
      "Last Update": nowISO(),
    });
    submissionData.recordId = recordId; 

    // 3. Submit jobs to the selected provider (Quick Submission: no sleep)
    const jobPromises = [];
    for (let i = 0; i < count; i++) {
      const p = (async () => {
        let requestId;
        
        if (provider === 'WaveSpeed') {
            // WaveSpeed submission should work fine
            requestId = await submitWaveSpeedJob({ ...submissionData, ...dataUrls });
        } else { // Fal
            // Fal submission, depends only on correct FAL_API_TOKEN
            requestId = await submitFalJob(submissionData);
        }
        return requestId;

      })();
      jobPromises.push(p);
    }

    const results = await Promise.allSettled(jobPromises);

    const requestIds = [];
    const failedMessages = [];

    results.forEach(r => {
      if (r.status === 'fulfilled') {
        requestIds.push(r.value);
      } else {
        failedMessages.push(r.reason.message);
      }
    });

    await patchRow(recordId, {
      "Request IDs": requestIds.join(","),
      "Failed IDs": failedMessages.join(","),
      "Status": requestIds.length > 0 ? "processing" : "failed",
      "Last Update": nowISO(),
      "Note": `🟢 Batch started with ${provider}. Submitted: ${requestIds.length}. Failed to submit: ${failedMessages.length}.`
    });

    res.json({ ok: true, parentRecordId: recordId, runId, message: `Batch started on ${provider}. Airtable will update when jobs finish.` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});


// ---------- Webhook Handler: WaveSpeed ----------
app.post("/webhooks/wavespeed", async (req, res) => {
  console.log("📩 Incoming WaveSpeed webhook:", JSON.stringify(req.body, null, 2));
  
  const recordId = req.query.record_id;
  if (!recordId) {
    console.warn("WaveSpeed Webhook received without a record_id query param.");
    return res.json({ ok: false, error: "Missing record_id" });
  }

  try {
    const data = req.body || {};
    const requestId = data.id || data.requestId || "";
    
    if (data.status === 'failed' || data.error) {
      console.error(`❌ WaveSpeed Job ${requestId} failed:`, data.error || 'Unknown error');
      const current = await getRow(recordId);
      const fields = current.fields || {};
      const prevFailed = (fields["Failed IDs"] || "").split(",").filter(Boolean);
      const updatedFailed = Array.from(new Set([...prevFailed, `${requestId} (runtime error)`])).join(",");
      await patchRow(recordId, { "Failed IDs": updatedFailed });
      return res.json({ ok: true, message: "Logged WaveSpeed failure." });
    }

    const outputsArray = Array.isArray(data.outputs) ? data.outputs : [];
    
    const imageUrls = outputsArray.filter(s => typeof s === 'string' && s.startsWith('http'))
                      .concat(data.output?.url || data.image || [])
                      .filter(Boolean);
                      
    const outputUrl = imageUrls[0] || null;

    if (!outputUrl) {
      console.warn(`WaveSpeed webhook for ${requestId} had no output URL.`);
      return res.json({ ok: true, error: "No output URL found in data.outputs" }); 
    }

    const current = await getRow(recordId);
    const fields = current.fields || {};
    
    const prevOutputs = Array.isArray(fields["Output"]) ? fields["Output"] : [];
    const prevSeen = (fields["Seen IDs"] || "").split(",").map(s => s.trim()).filter(Boolean);
    const allRequests = (fields["Request IDs"] || "").split(",").map(s => s.trim()).filter(Boolean);

    const updatedOutputs = [...prevOutputs, { url: outputUrl }];
    const updatedSeen = Array.from(new Set([...prevSeen, requestId]));

    const isComplete = allRequests.length > 0 && updatedSeen.length >= allRequests.length;
    
    const fieldsToUpdate = {
      "Output": updatedOutputs,
      "Output URL": outputUrl, 
      "Seen IDs": updatedSeen.join(","), 
      "Last Update": nowISO(),
      "Note": `✅ WaveSpeed: Received image ${updatedSeen.length} of ${allRequests.length}`,
    };

    if (isComplete) {
      fieldsToUpdate["Status"] = "completed"; 
      fieldsToUpdate["Completed At"] = nowISO();
      fieldsToUpdate["Note"] = `✅ WaveSpeed batch complete. Received ${updatedSeen.length} images.`;
    }

    await patchRow(recordId, fieldsToUpdate);

    console.log(`✅ Airtable updated for WaveSpeed record ${recordId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`❌ WaveSpeed webhook error for record ${recordId}:`, err.message);
    res.json({ ok: false });
  }
});


// ---------- Webhook Handler: Fal AI ----------
app.post("/webhooks/fal", async (req, res) => {
  console.log("📩 Incoming Fal webhook:", JSON.stringify(req.body, null, 2));
  
  const recordId = req.query.record_id;
  if (!recordId) {
    console.warn("Fal Webhook received without a record_id query param.");
    return res.json({ ok: false, error: "Missing record_id" });
  }

  try {
    const data = req.body || {};
    const requestId = data.request_id || data.id || "";
    
    if (data.status === 'error' || data.error) {
      console.error(`❌ Fal Job ${requestId} failed:`, data.error || 'Unknown error');
      const current = await getRow(recordId);
      const fields = current.fields || {};
      const prevFailed = (fields["Failed IDs"] || "").split(",").filter(Boolean);
      const updatedFailed = Array.from(new Set([...prevFailed, `${requestId} (Fal error)`])).join(",");
      await patchRow(recordId, { "Failed IDs": updatedFailed });
      return res.json({ ok: true, message: "Logged Fal failure." });
    }
    
    const outputUrl = data.images?.[0]?.url || data.output?.url || null; 

    if (!outputUrl) {
      console.warn(`Fal webhook for ${requestId} had no output URL.`);
      return res.json({ ok: true, error: "No output URL found in Fal response" }); 
    }

    const current = await getRow(recordId);
    const fields = current.fields || {};
    
    const prevOutputs = Array.isArray(fields["Output"]) ? fields["Output"] : [];
    const prevSeen = (fields["Seen IDs"] || "").split(",").map(s => s.trim()).filter(Boolean);
    const allRequests = (fields["Request IDs"] || "").split(",").map(s => s.trim()).filter(Boolean);

    const updatedOutputs = [...prevOutputs, { url: outputUrl }];
    const updatedSeen = Array.from(new Set([...prevSeen, requestId]));

    const isComplete = allRequests.length > 0 && updatedSeen.length >= allRequests.length;
    
    const fieldsToUpdate = {
      "Output": updatedOutputs,
      "Output URL": outputUrl, 
      "Seen IDs": updatedSeen.join(","), 
      "Last Update": nowISO(),
      "Note": `✅ Fal: Received image ${updatedSeen.length} of ${allRequests.length}`,
    };

    if (isComplete) {
      fieldsToUpdate["Status"] = "completed"; 
      fieldsToUpdate["Completed At"] = nowISO();
      fieldsToUpdate["Note"] = `✅ Fal batch complete. Received ${updatedSeen.length} images.`;
    }

    await patchRow(recordId, fieldsToUpdate);

    console.log(`✅ Airtable updated for Fal record ${recordId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`❌ Fal webhook error for record ${recordId}:`, err.message);
    res.json({ ok: false });
  }
});


app.get("/", (_req, res) => res.send("Multi-Provider Batch Server running. Visit /app"));
app.listen(PORT, () => console.log(`✅ Listening on port ${PORT}`));