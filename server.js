const express = require('express');
const cors = require('cors');
const { exec, execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
const port = Number(process.env.PORT) || 4000;
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`)
    .replace(/\/$/, '');

const downloadDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);
const searchResultLimit = 33;
const ytdlpPath = process.env.YT_DLP_PATH
    || (process.platform === 'win32' ? path.join(__dirname, 'yt-dlp.exe') : 'yt-dlp');
const ffmpegPath = process.env.FFMPEG_PATH
    || (process.platform === 'win32' ? path.join(__dirname, 'ffmpeg.exe') : 'ffmpeg');

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// 1. Endpoint para buscar canciones
// 1. Endpoint para buscar canciones
app.get('/api/search', (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Falta el parámetro de búsqueda' });

    execFile(ytdlpPath, [
        '--js-runtimes', 'node',
        `ytsearch${searchResultLimit}:${query} audio`,
        '--print', '%(id)s||%(title)s||%(uploader)s||%(duration_string)s||%(thumbnail)s'
    ], (error, stdout, stderr) => {
        if (error) {
            console.warn('La búsqueda tuvo errores parciales:', stderr);
            if (!stdout.trim()) {
                return res.status(500).json({ error: 'Error interno ejecutando yt-dlp', details: stderr });
            }
        }

        if (!stdout.trim()) {
            return res.status(500).json({ error: 'No se encontraron resultados' });
        }

        const lines = stdout.trim().split('\n').slice(0, searchResultLimit);
        const results = lines.map(line => {
            const [id, title, artist, duration, thumbnail] = line.split('||');
            return {
                id,
                title: title || 'Desconocido',
                artist: artist || 'YouTube Music',
                duration: duration || '0:00',
                thumbnail: thumbnail || '',
                streamUrl: `${publicBaseUrl}/api/stream?id=${encodeURIComponent(id)}`
            };
        });

        res.json(results);
    });
});

app.get('/api/downloaded', (req, res) => {
    fs.readdir(downloadDir, (error, files) => {
        if (error) return res.status(500).json({ error: 'No se pudieron leer las descargas locales' });
        const ids = files
            .filter(file => /^[\w-]+\.mp3$/i.test(file))
            .map(file => path.basename(file, '.mp3'));
        res.json(ids);
    });
});

app.get('/api/local-audio', (req, res) => {
    const videoId = req.query.id;
    if (typeof videoId !== 'string' || !/^[\w-]+$/.test(videoId)) {
        return res.status(400).send('ID no válido');
    }

    const filePath = path.join(downloadDir, `${videoId}.mp3`);
    if (!fs.existsSync(filePath)) {
        return res.redirect(`/api/stream?id=${encodeURIComponent(videoId)}`);
    }
    res.setHeader('Cache-Control', 'no-store');
    res.type('audio/mpeg');
    return res.sendFile(filePath);
});

// 2. Endpoint de Streaming en línea
app.get('/api/stream', (req, res) => {
    const videoId = req.query.id;
    if (!videoId) return res.status(400).send('ID requerido');

    const videoUrl = new URL('https://www.youtube.com/watch');
    videoUrl.searchParams.set('v', videoId);
    execFile(ytdlpPath, [
        '-f', 'bestaudio',
        '-g', videoUrl.toString()
    ], async (error, stdout) => {
        if (error || !stdout.trim()) return res.status(500).send('Error al obtener stream');
        const directUrl = stdout.trim().split('\n')[0];
        const transcoder = spawn(ffmpegPath, [
            '-hide_banner', '-loglevel', 'error', '-i', directUrl,
            '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', 'pipe:1'
        ]);

        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'no-store');
        transcoder.stdout.pipe(res);
        transcoder.stderr.on('data', output => console.error('FFmpeg:', output.toString().trim()));
        transcoder.on('error', streamError => {
            console.error('Error al iniciar FFmpeg:', streamError);
            if (!res.headersSent) res.status(502).end('Error al convertir el audio');
            else res.destroy(streamError);
        });
        transcoder.on('close', code => {
            if (code && !res.headersSent) res.status(502).end('Error al convertir el audio');
        });
        res.on('close', () => {
            if (!res.writableEnded) transcoder.kill();
        });
    });
});

// 3. Endpoint para descargar el archivo MP3
// 3. Endpoint para descargar el archivo MP3
app.get('/api/download', (req, res) => {
    const videoId = req.query.id;
    if (typeof videoId !== 'string' || !/^[\w-]+$/.test(videoId)) {
        return res.status(400).json({ error: 'ID no válido' });
    }

    const filePath = path.join(downloadDir, `${videoId}.mp3`);
    const respondWithDownload = () => req.query.json === '1'
        ? res.json({ id: videoId, downloaded: true })
        : res.download(filePath);

    if (fs.existsSync(filePath)) {
        return respondWithDownload();
    }

    const videoUrl = new URL('https://www.youtube.com/watch');
    videoUrl.searchParams.set('v', videoId);
    execFile(ytdlpPath, [
        '--js-runtimes', 'node',
        '-x', '--audio-format', 'mp3',
        '-o', filePath,
        videoUrl.toString()
    ], (err, stdout, stderr) => {
        if (err) {
            console.error("Error al descargar/convertir:", err);
            console.error("Stderr:", stderr);
            return res.status(500).json({ error: 'Error al procesar la descarga', details: stderr });
        }
        if (!fs.existsSync(filePath)) {
            return res.status(500).json({ error: 'La descarga no generó un archivo MP3' });
        }
        respondWithDownload();
    });
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Backend de MUUM corriendo en el puerto ${port}`);
});