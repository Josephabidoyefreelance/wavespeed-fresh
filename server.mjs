import 'dotenv/config';
import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";

const {
  PORT = 4000,
  PUBLIC_BASE_URL,
  WAVESPEED_API_KEY,
  AIRTABLE_PAT,
  AIRTABLE_BASE_ID,
  AIRTABLE_TABLE
} = process.env;

// Check for required environment variables (crucial for both local and Render)
if (!PUBLIC_BASE_URL || !WAVESPEED_API_KEY || !AIRTABLE_PAT || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE) {
  console.error("❌ Missing required env vars. Check your .env file or Render settings.");
  process.error("Missing required environment variables.");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
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

// Helper function to convert URL to Base64
async function urlToDataURL(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get("content-type") || "image/png";
  return `data:${type};base64,${buf.toString("base64")}`;
}

// ---------- WaveSpeed Job Submission (WORKING MODEL) ----------
async function submitWaveSpeedJob({ prompt, subjectDataUrl, referenceDataUrls, width, height, runId, recordId }) {
    
    // MODEL PATH: Standard Seedream V4 (T2I) - This model is licensed for your key.
    const modelPath = "bytedance/seedream-v4"; 
    
    // PAYLOAD ID: The corresponding ID
    const simplifiedModelName = "bytedance/seedream-v4"; 

    // Combine subject and references into a single array for the API
    const allImages = (subjectDataUrl ? [subjectDataUrl] : []).concat(referenceDataUrls || []);

    const payload = {
        prompt,
        model: simplifiedModelName, 
        width: Number(width) || 1024,
        height: Number(height) || 1024,
        images: allImages, // Images are included now
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
    
    // ID PARSING FIX: Access the inner 'data' object
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

// ---------- UI (IMAGE INPUTS RESTORED) ----------
app.get("/app", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WaveSpeed Dashboard</title>
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
input,textarea{
  width:100%;padding:10px;margin-top:6px;
  border:none;border-radius:8px;
  background:rgba(255,255,255,0.1);
  color:#fff;font-size:14px;transition:.3s;
}
input:focus,textarea:focus{background:rgba(255,255,255,0.2);outline:none;}
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
<h1>⚡ WaveSpeed Seedream v4 — Image-Conditioned Runner</h1>
<form id="batchForm">
  <label>Prompt</label>
  <textarea name="prompt" rows="3" required placeholder="Describe your dream image..."></textarea>
  <label>Subject image URL (Optional)</label>
  <input name="subjectUrl" type="url" placeholder="https://example.com/subject.png">
  <label>Reference image URLs (comma-separated, Optional)</label>
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

// ---------- API (IMAGE DATA HANDLING RESTORED) ----------
app.post("/api/start-batch", async (req, res) => {
  try {
    const { prompt, subjectUrl = "", referenceUrls = "", width = 1024, height = 1024, count = 1 } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const refs = referenceUrls.split(",").map(s => s.trim()).filter(Boolean);
    const runId = crypto.randomUUID();

    // Create the row with a "pending" status first
    const recordId = await createRow({
      "Prompt": prompt,
      "Subject": subjectUrl ? [{ url: subjectUrl }] : [],
      "References": refs.map(u => ({ url: u })),
      "Model": "Seedream v4 (T2I + Image Condition)", // Display name for Airtable
      "Size": `${width}x${height}`,
      "Status": "pending", // Start as pending
      "Run ID": runId,
      "Created At": nowISO(),
      "Last Update": nowISO(),
    });

    console.log(`Created Airtable row: ${recordId}`);

    // Fetch and convert image URLs to Base64 
    let subjectData = null;
    if (subjectUrl) {
        subjectData = await urlToDataURL(subjectUrl);
    }
    const refData = await Promise.all(refs.map(urlToDataURL));

    const jobPromises = [];
    for (let i = 0; i < count; i++) {
      const p = (async (delay) => {
        await sleep(delay);
        return submitWaveSpeedJob({
          prompt,
          subjectDataUrl: subjectData, 
          referenceDataUrls: refData, 
          width,
          height,
          runId,
          recordId
        });
      })(i * 1200);
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
      "Note": `🟢 Batch started. Submitted: ${requestIds.length}. Failed to submit: ${failedMessages.length}.`
    });

    res.json({ ok: true, parentRecordId: recordId, runId, message: "Batch started. Airtable will update when jobs finish." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- Webhook (FINAL FIX FOR OUTPUT PARSING) ----------
app.post("/webhooks/wavespeed", async (req, res) => {
  console.log("📩 Incoming webhook:", JSON.stringify(req.body, null, 2));
  
  const recordId = req.query.record_id;
  if (!recordId) {
    console.warn("Webhook received without a record_id query param.");
    return res.json({ ok: false, error: "Missing record_id" });
  }

  try {
    const data = req.body || {};
    const requestId = data.id || data.requestId || "";
    
    // Check if job failed
    if (data.status === 'failed' || data.error) {
      console.error(`❌ Job ${requestId} failed:`, data.error || 'Unknown error');
      const current = await getRow(recordId);
      const fields = current.fields || {};
      const prevFailed = (fields["Failed IDs"] || "").split(",").filter(Boolean);
      const updatedFailed = Array.from(new Set([...prevFailed, `${requestId} (runtime error)`])).join(",");
      await patchRow(recordId, { "Failed IDs": updatedFailed });
      return res.json({ ok: true, message: "Logged failure." });
    }

    // FIX IS HERE: Correctly handle 'outputs' array of strings
    
    // 1. Prioritize data.outputs (the array of URL strings)
    const outputsArray = Array.isArray(data.outputs) ? data.outputs : [];
    
    // 2. Extract URL strings directly, or fall back to single image fields
    const imageUrls = outputsArray.filter(s => typeof s === 'string' && s.startsWith('http'))
                      .concat(data.output?.url || data.image || [])
                      .filter(Boolean);
                      
    const outputUrl = imageUrls[0] || null;

    if (!outputUrl) {
      // The status is 'completed' but we couldn't find a URL. Log and return OK.
      console.warn(`Webhook for ${requestId} had no output URL.`);
      return res.json({ ok: true, error: "No output URL found in data.outputs" }); 
    }

    // END FIX 

    const current = await getRow(recordId);
    const fields = current.fields || {};
    
    // Logic to track completed IDs (Seen IDs)
    const prevOutputs = Array.isArray(fields["Output"]) ? fields["Output"] : [];
    const prevSeen = (fields["Seen IDs"] || "").split(",").map(s => s.trim()).filter(Boolean);
    const allRequests = (fields["Request IDs"] || "").split(",").map(s => s.trim()).filter(Boolean);

    const updatedOutputs = [...prevOutputs, { url: outputUrl }];
    const updatedSeen = Array.from(new Set([...prevSeen, requestId]));

    // Check for completion logic
    const isComplete = allRequests.length > 0 && updatedSeen.length >= allRequests.length;
    
    const fieldsToUpdate = {
      "Output": updatedOutputs,
      "Output URL": outputUrl, // Store the final image URL
      "Seen IDs": updatedSeen.join(","), // Display the seen job ID
      "Last Update": nowISO(),
      "Note": `✅ Received image ${updatedSeen.length} of ${allRequests.length}`,
    };

    if (isComplete) {
      console.log(`Batch ${recordId} is now complete!`);
      fieldsToUpdate["Status"] = "completed"; // Status change
      fieldsToUpdate["Completed At"] = nowISO();
      fieldsToUpdate["Note"] = `✅ Batch complete. Received ${updatedSeen.length} images.`;
    }

    await patchRow(recordId, fieldsToUpdate);

    console.log(`✅ Airtable updated for record ${recordId}`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`❌ Webhook error for record ${recordId}:`, err.message);
    res.json({ ok: false });
  }
});

app.get("/", (_req, res) => res.send("WaveSpeed Batch Server running. Visit /app"));
app.listen(PORT, () => console.log(`✅ Listening on http://localhost:${PORT}`));