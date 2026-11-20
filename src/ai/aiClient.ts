import WebSocket from 'ws';
import { AiClientCallback, AiServerMessage, RawVmMessage, VmStartMessage } from "./ai.type";


export class AiClient {

    private ws : WebSocket | null = null;
    private url : string;
    private callbacks : AiClientCallback;
    private isConnected : boolean = false;

    constructor(url : string, callbacks : AiClientCallback){
        this.url = url;
        this.callbacks = callbacks;
    }

    public connect() {
        if(this.ws) return;

        this.ws = new WebSocket(this.url);

        this.ws.on("open", () => {
            this.isConnected = true;
            console.log(`AI connected`);
        })

        this.ws.on("message", (data : WebSocket.RawData) => {
            this.handleIncomingMessage(data);
        })

        this.ws.on("error", (err: Error) => {
            console.error('[AiClient] WebSocket error:', err.message);
            if (this.callbacks.onError) {
                this.callbacks.onError(err);
            }
        });

        this.ws.on("close", (code: number, reason: Buffer) => {
            this.isConnected = false;
            const reasonStr = reason.toString('utf-8');
            console.log(`[AiClient] WebSocket closed (${code}): ${reasonStr || 'No reason'}`);
            if (this.callbacks.onClose) {
                this.callbacks.onClose(code, reasonStr);
            }
        });
    }

    public sendAudio(audioChunk : Buffer) : void {
        if(!this.ws || !this.isConnected || this.ws.readyState !== WebSocket.OPEN){
            return;
        }
        this.ws.send(audioChunk);
    }

    public close(): void {
        if(this.ws){
            this.ws.close();
            this.ws = null;
            this.isConnected = false;
        }
    }

    public get ready() : boolean {
        return this.isConnected;
    }

    private handleIncomingMessage(rawData : WebSocket.RawData){
        try {
            const text = rawData.toString('utf-8');
            const parsed : AiServerMessage = JSON.parse(text);

            if(parsed.type === "vm_start"){
                const startData = parsed as VmStartMessage;
                console.log(`[AiClient] Handshake acknowledged. Sample rate: ${startData.sr}Hz`);

                if(this.callbacks.onStart){
                    this.callbacks.onStart(startData);
                }
            }else if(parsed.type === "raw_vm"){
                const vmData = parsed as RawVmMessage;
                console.log(`[AiClient] Prediction received: ${vmData.prediction}`);
                
                
                if(this.callbacks.onDecision){
                    this.callbacks.onDecision(vmData.prediction, vmData);
                }
            }else{
                console.warn('[AiClient] Unknown payload:', parsed);
            }
            
        } catch (error) {
            console.error('[AiClient] Failed to parse message JSON:', error);
        }
    }   

}