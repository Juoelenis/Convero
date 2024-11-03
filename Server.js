// server.js
const express = require('express');
const Busboy = require('busboy');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
const wss = new WebSocket.Server({ port: 8080 });

const uploadsDir = 'uploads/';
const conversionQueue = {};

// WebSocket connection for progress updates
wss.on('connection', (ws) => {
  console.log('WebSocket connection established');
  ws.on('close', () => console.log('WebSocket connection closed'));
});

// Utility to send progress updates to all WebSocket clients
function sendProgressUpdate(jobId, progress) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ jobId, progress }));
    }
  });
}

// Conversion function to handle large files
function convertFile(inputFilePath, outputFormat, jobId, ws) {
  const outputFilePath = path.join(uploadsDir, `${jobId}.${outputFormat}`);
  
  ffmpeg(inputFilePath)
    .toFormat(outputFormat)
    .on('progress', (progress) => {
      const percent = Math.floor(progress.percent || 0);
      sendProgressUpdate(jobId, percent); // Send progress over WebSocket
    })
    .on('end', () => {
      conversionQueue[jobId] = { status: 'completed', outputFilePath };
      sendProgressUpdate(jobId, 100);
      ws.send(JSON.stringify({ jobId, status: 'completed', outputFilePath }));
    })
    .on('error', (err) => {
      console.error(err);
      ws.send(JSON.stringify({ jobId, status: 'failed', error: 'Conversion failed' }));
      fs.unlinkSync(inputFilePath);
    })
    .save(outputFilePath);
}

// Route to handle large file upload and conversion
app.post('/upload', (req, res) => {
  const busboy = new Busboy({ headers: req.headers });
  const jobId = uuidv4();
  const outputFormat = req.query.format || 'wma';
  const inputFilePath = path.join(uploadsDir, `${jobId}.mp3`);

  busboy.on('file', (fieldname, file, filename) => {
    // Stream file to disk to avoid memory issues
    const writeStream = fs.createWriteStream(inputFilePath);
    file.pipe(writeStream);

    file.on('end', () => {
      console.log(`File [${filename}] uploaded as ${inputFilePath}`);
    });
  });

  busboy.on('finish', () => {
    res.json({ jobId, message: 'File upload complete. Conversion in progress.' });

    // Initiate the conversion in a background process
    const wsClient = Array.from(wss.clients)[0];
    convertFile(inputFilePath, outputFormat, jobId, wsClient);
  });

  req.pipe(busboy);
});

// Route to download converted file by job ID
app.get('/download/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = conversionQueue[jobId];

  if (job && job.status === 'completed') {
    res.download(job.outputFilePath, (err) => {
      if (err) console.error(err);
      fs.unlinkSync(job.outputFilePath); // Cleanup after download
      delete conversionQueue[jobId];
    });
  } else {
    res.status(404).send('File not found or conversion in progress');
  }
});

app.listen(3000, () => console.log('Server started on http://localhost:3000'));
