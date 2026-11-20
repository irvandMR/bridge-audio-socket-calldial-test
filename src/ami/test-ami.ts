import dotenv from 'dotenv';
import { AmiClient } from './amiClient';

dotenv.config();

const amiConfig = {
  host: process.env.AMI_HOST || '127.0.0.1',
  port: parseInt(process.env.AMI_PORT || '5038', 10),
  user: process.env.AMI_USER || 'nodejs-ami',
  secret: process.env.AMI_SECRET || 'Pass1234'
};

console.log('🚀 Memulai pengujian koneksi ke Asterisk AMI...');
console.log(`Target: ${amiConfig.user}@${amiConfig.host}:${amiConfig.port}`);

const ami = new AmiClient(amiConfig, {
  onConnect: () => {
    console.log('✅ TCP Socket tersambung ke port AMI!');
  },
  onAuthenticated: () => {
    console.log('🎉 Login AMI SUKSES! Credential valid.');

    // Coba kirim action Ping untuk menguji komunikasi dua arah
    console.log('📤 Mengirim Action Ping...');
    ami.sendAction('Ping', { ActionID: 'test_ping_001' });

    // Coba simulasikan kirim UserEvent AMD dummy
    console.log('📤 Mengirim Action UserEvent (AMDResult test)...');
    ami.sendUserEvent('AMDResult', {
      Channel: 'TestChannel/Dummy-001',
      Result: 'HUMAN'
    });

    console.log('👂 Menunggu event dari Asterisk selama 5 detik...');
    setTimeout(() => {
      console.log('🧹 Menutup koneksi pengujian...');
      ami.disconnect();
      console.log('🏁 Pengujian selesai.');
      process.exit(0);
    }, 5000);
  },
  onEvent: (event) => {
    // Tampilkan jika ada event channel hangup/newchannel yang lewat
    if (['hangup', 'newchannel', 'userevent'].includes(event.event?.toLowerCase() || '')) {
      console.log(`[Event Asterisk] ${event.event}:`, event);
    }
  },
  onError: (err) => {
    console.error('❌ Terjadi error pada AMI Socket:', err.message);
  },
  onClose: (hadError) => {
    console.log(`🔌 Koneksi AMI ditutup (hadError: ${hadError})`);
  }
});

// Jalankan koneksi
ami.connect();