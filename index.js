const express = require('express');
const SFTPClient = require('ssh2-sftp-client');
const XLSX = require('xlsx');
const app = express();
const cors = require('cors');

// Configuración - USAR VARIABLES DE ENTORNO
const PORT = process.env.PORT || 3001;
const SFTP_CONFIG = {
    host: process.env.SFTP_HOST || 'sftp19.sapsf.com',
    username: process.env.SFTP_USER || '6702954T',
    password: process.env.SFTP_PASSWORD || 'Hs9XV#8Q1@aI',
    remoteFilePath: process.env.SFTP_FILE_PATH || '/Reporte_Objetivos/Reporte_Objetivos_2026.xlsx'
};

// Configuración de CORS - AJUSTA según tu frontend desplegado
const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:3000',
    'https://tu-frontend.vercel.app',    // Reemplaza con tu URL de frontend
    'https://tu-frontend.netlify.app'     // Reemplaza con tu URL de frontend
];

app.use(cors({
    origin: function (origin, callback) {
        // Permitir solicitudes sin origin (como apps móviles o postman)
        if (!origin) return callback(null, true);
        if (allowedOrigins.indexOf(origin) === -1) {
            return callback(new Error('CORS not allowed'), false);
        }
        return callback(null, true);
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Cache en memoria
let cachedData = null;
let lastUpdate = null;
let isUpdating = false;
const CACHE_UPDATE_INTERVAL = 5 * 60 * 1000; // 5 minutos

// Función para obtener datos del SFTP
async function fetchDataFromSFTP() {
    const sftp = new SFTPClient();
    try {
        console.log(`[${new Date().toISOString()}] 🔄 Conectando al SFTP...`);
        
        await sftp.connect({
            host: SFTP_CONFIG.host,
            username: SFTP_CONFIG.username,
            password: SFTP_CONFIG.password
        });

        console.log(`[${new Date().toISOString()}] ✅ Conectado, leyendo archivo...`);
        const fileBuffer = await sftp.get(SFTP_CONFIG.remoteFilePath);
        console.log(`[${new Date().toISOString()}] 📦 Archivo leído: ${fileBuffer.length} bytes`);

        const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json(worksheet);

        const datosTransformados = jsonData.map(item => ({
            Jefe_directo: `${item['Nombre de Jefe inmediato'] || ''} ${item['Apellido de Jefe inmediato'] || ''}`.trim(),
            Departamento: item['Propietario de Objetivo Departamento'] || '',
            Propietario: `${item['Propietario de Objetivo Nombre'] || ''} ${item['Propietario de Objetivo Apellidos'] || ''}`.trim(),
            Objetivo: item['Nombre del Objetivo'] || '',
            Avance: parseFloat(item['% Realizado']) || 0
        }));

        console.log(`[${new Date().toISOString()}] ✅ Datos transformados: ${datosTransformados.length} registros`);

        return {
            success: true,
            data: datosTransformados,
            metadata: {
                totalRegistros: datosTransformados.length,
                lastUpdate: new Date().toISOString()
            }
        };
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Error en fetchDataFromSFTP:`, error);
        throw error;
    } finally {
        await sftp.end();
    }
}

// Función para actualizar caché
async function updateCache() {
    if (isUpdating) {
        console.log(`[${new Date().toISOString()}] ⏳ Ya hay una actualización en curso`);
        return;
    }

    isUpdating = true;
    try {
        console.log(`[${new Date().toISOString()}] 🔄 Iniciando actualización de caché...`);
        const newData = await fetchDataFromSFTP();
        cachedData = newData;
        lastUpdate = new Date();
        console.log(`[${new Date().toISOString()}] ✅ Caché actualizado: ${newData.metadata.totalRegistros} registros`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Error actualizando caché:`, error);
    } finally {
        isUpdating = false;
    }
}

// Endpoint principal
app.get('/api/reporte-objetivos', async (req, res) => {
    try {
        // Si no hay caché, obtener datos inmediatamente
        if (!cachedData) {
            console.log(`[${new Date().toISOString()}] 📦 Primera carga - obteniendo datos...`);
            await updateCache();
        }

        // Devolver datos del caché
        res.json({
            ...cachedData,
            metadata: {
                ...cachedData.metadata,
                fromCache: true,
                cacheAge: lastUpdate ? Math.floor((Date.now() - lastUpdate) / 1000) + 's' : 'N/A'
            }
        });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Error en endpoint:`, error);
        res.status(500).json({
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Endpoint de health check (¡IMPORTANTE para Railway, Heroku, etc!)
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        cache: {
            hasData: !!cachedData,
            lastUpdate: lastUpdate,
            recordsCount: cachedData?.metadata?.totalRegistros || 0
        }
    });
});

// Endpoint para forzar actualización (protegido)
app.post('/api/actualizar', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    // Define una API key en variables de entorno para proteger este endpoint
    if (apiKey !== process.env.UPDATE_API_KEY) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    
    await updateCache();
    res.json({ success: true, lastUpdate });
});

// Iniciar actualización automática
updateCache(); // Primera carga
setInterval(updateCache, CACHE_UPDATE_INTERVAL);

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`🚀 Backend escuchando en puerto ${PORT}`);
    console.log(`📊 Endpoint: /api/reporte-objetivos`);
    console.log(`🩺 Health check: /health`);
    console.log(`⏰ Actualización cada ${CACHE_UPDATE_INTERVAL/60000} minutos`);
});