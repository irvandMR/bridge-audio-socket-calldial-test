import { CONFIG } from '../config/config';
import { AmiClient } from './amiClient';
import { AmiEvent } from './ami.type';

console.log('🚀 Memulai pengujian koneksi ke Asterisk AMI...');
console.log(`Target: ${CONFIG.ami.user}@${CONFIG.ami.host}:${CONFIG.ami.port}`);

const ami = new AmiClient(CONFIG.ami, {
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
  onEvent: (event: AmiEvent) => {
    // Tampilkan jika ada event channel hangup/newchannel yang lewat
    if (['hangup', 'newchannel', 'userevent'].includes(event.event?.toLowerCase() || '')) {
      console.log(`[Event Asterisk] ${event.event}:`, event);
    }
  },
  onError: (err: Error) => {
    console.error('❌ Terjadi error pada AMI Socket:', err.message);
  },
  onClose: (hadError: boolean) => {
    console.log(`🔌 Koneksi AMI ditutup (hadError: ${hadError})`);
  }
});

// Jalankan koneksi
ami.connect();
