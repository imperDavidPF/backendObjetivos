const express = require('express');
const SFTPClient = require('ssh2-sftp-client');
const XLSX = require('xlsx');
const app = express();
const cors = require('cors');

// Configuración
const PORT = process.env.PORT || 3001;
const SFTP_CONFIG = {
    host: process.env.SFTP_HOST || 'sftp19.sapsf.com',
    username: process.env.SFTP_USER || '6702954T',
    password: process.env.SFTP_PASSWORD || 'Hs9XV#8Q1@aI',
    remoteFilePath: process.env.SFTP_FILE_PATH || '/Reporte_Objetivos/Reporte_Objetivos_2026.xlsx'
};

// CORS
app.use(cors({
    origin: ['http://localhost:5173', 'https://backendobjetivos-production.up.railway.app'],
    methods: ['GET', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

// Cache
let cachedData = null;
let lastUpdate = null;
let isUpdating = false;
let updateError = null;

// Función para obtener datos del SFTP
async function fetchDataFromSFTP() {
    const sftp = new SFTPClient();
    try {
        console.log(`[${new Date().toISOString()}] 🔄 Conectando al SFTP...`);
        
        await sftp.connect({
            host: SFTP_CONFIG.host,
            username: SFTP_CONFIG.username,
            password: SFTP_CONFIG.password,
            readyTimeout: 60000,
            algorithms: {
                kex: [
                    'diffie-hellman-group1-sha1',
                    'ecdh-sha2-nistp256',
                    'ecdh-sha2-nistp384',
                    'ecdh-sha2-nistp521',
                    'diffie-hellman-group-exchange-sha256',
                    'diffie-hellman-group14-sha1'
                ],
                cipher: [
                    'aes128-ctr',
                    'aes192-ctr',
                    'aes256-ctr',
                    'aes128-gcm',
                    'aes256-gcm',
                    'aes256-cbc'
                ],
                serverHostKey: [
                    'ssh-rsa',
                    'ecdsa-sha2-nistp256',
                    'ecdsa-sha2-nistp384',
                    'ecdsa-sha2-nistp521'
                ],
                hmac: ['hmac-sha2-256', 'hmac-sha2-512', 'hmac-sha1']
            }
        });

        console.log(`[${new Date().toISOString()}] ✅ Conectado, leyendo archivo...`);
        const fileBuffer = await sftp.get(SFTP_CONFIG.remoteFilePath);

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
        console.error(`[${new Date().toISOString()}] ❌ Error:`, error);
        throw error;
    } finally {
        await sftp.end();
    }
}

// Función para actualizar caché
async function updateCache() {
    if (isUpdating) {
        console.log(`[${new Date().toISOString()}] ⏳ Actualización en curso...`);
        return;
    }

    isUpdating = true;
    updateError = null;
    
    try {
        console.log(`[${new Date().toISOString()}] 🔄 Actualizando caché...`);
        const newData = await fetchDataFromSFTP();
        cachedData = newData;
        lastUpdate = new Date();
        console.log(`[${new Date().toISOString()}] ✅ Caché actualizado: ${newData.metadata.totalRegistros} registros`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ❌ Error actualizando caché:`, error);
        updateError = error.message;
    } finally {
        isUpdating = false;
    }
}

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        cache: {
            hasData: !!cachedData,
            lastUpdate: lastUpdate,
            recordsCount: cachedData?.metadata?.totalRegistros || 0,
            isUpdating: isUpdating,
            error: updateError
        }
    });
});

// ✅ ENDPOINT PRINCIPAL CORREGIDO
app.get('/api/reporte-objetivos', async (req, res) => {
    try {
        // Si no hay datos en caché, intentar obtenerlos
        if (!cachedData) {
            console.log(`[${new Date().toISOString()}] 📦 Primera carga - obteniendo datos...`);
            await updateCache();
        }

        // Si todavía no hay datos, hay un error
        if (!cachedData) {
            return res.status(503).json({
                success: false,
                error: 'No hay datos disponibles en este momento',
                details: updateError || 'Error en la conexión SFTP',
                timestamp: new Date().toISOString()
            });
        }

        // ✅ Devolver datos correctamente
        res.json({
            success: true,
            data: cachedData.data,
            metadata: {
                totalRegistros: cachedData.metadata.totalRegistros,
                lastUpdate: cachedData.metadata.lastUpdate,
                fromCache: true
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

// Endpoint para forzar actualización
app.post('/api/actualizar', async (req, res) => {
    await updateCache();
    res.json({
        success: true,
        message: 'Actualización forzada completada',
        lastUpdate: lastUpdate,
        hasData: !!cachedData
    });
});

// Iniciar caché al arrancar
updateCache();

// Actualización periódica cada 5 minutos
setInterval(updateCache, 5 * 60 * 1000);

app.listen(PORT, () => {
    console.log(`🚀 Backend escuchando en puerto ${PORT}`);
    console.log(`📊 Endpoint: /api/reporte-objetivos`);
    console.log(`🩺 Health check: /health`);
    console.log(`🔄 Actualización manual: POST /api/actualizar`);
});