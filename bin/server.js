#!/usr/bin/env node
import fastify from 'fastify';
import cors from '@fastify/cors';
import { FastifySSEPlugin } from "fastify-sse-v2";
import fs from 'fs';
import { pathToFileURL } from 'url'
import ChatGPTClient from '../src/ChatGPTClient.js';
import BingAIClient from '../src/BingAIClient.js';
import { KeyvFile } from 'keyv-file';

import CyclicDb from "@cyclic.sh/dynamodb";
const conversationKV = CyclicDb(process.env.CYCLIC_DB).collection("conversation");

const arg = process.argv.find((arg) => arg.startsWith('--settings'));
let path;
if (arg) {
    path = arg.split('=')[1];
} else {
    path = './settings.js';
}

let settings;
if (fs.existsSync(path)) {
    // get the full path
    const fullPath = fs.realpathSync(path);
    settings = (await import(pathToFileURL(fullPath).toString())).default;
} else {
    if (arg) {
        console.error(`Error: the file specified by the --settings parameter does not exist.`);
    } else {
        console.error(`Error: the settings.js file does not exist.`);
    }
    process.exit(1);
}

if (settings.storageFilePath && !settings.cacheOptions.store) {
    // make the directory and file if they don't exist
    const dir = settings.storageFilePath.split('/').slice(0, -1).join('/');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(settings.storageFilePath)) {
        fs.writeFileSync(settings.storageFilePath, '');
    }

    settings.cacheOptions.store = new KeyvFile({ filename: settings.storageFilePath });
}

const clientToUse = settings.apiOptions?.clientToUse || settings.clientToUse || 'chatgpt';

let client;
switch (clientToUse) {
    case 'bing':
        client = new BingAIClient(settings.bingAiClient);
        break;
    default:
        client = new ChatGPTClient(
            settings.openaiApiKey,
            settings.chatGptClient,
            settings.cacheOptions,
        );
        break;
}

const server = fastify({ logger: true });

//const fastify = require('fastify')({logger: true})
//const path = require('path')
import fastifyStatic from '@fastify/static';
server.register(fastifyStatic, {
    root: '/workspaces/chatgpt-web-ui/dist/',
    //prefix: '/public/', // optional: default '/'
})

await server.register(FastifySSEPlugin);
await server.register(cors, {
    origin: '*',
});

server.post('/conversation/:conversationID', async (request, reply) => {
    const body = request.body || {};
    const { conversationID } = request.params;

    let onProgress;
    if (body.stream === true) {
        function waitConversationKV(ms) {
            return new Promise((resolve) => {
                let check;
                check = setInterval(async () => {
                    let conversation = await conversationKV.get(conversationID);
                    if (conversation) {
                        resolve(conversation);
                        clearInterval(check);
                    }
                }, ms);
            });
        }

        let conversationStart = true, conversationCount = 0;
        onProgress = async (token) => {
            if (settings.apiOptions?.debug) {
                console.debug(token);
            }
            //reply.sse({ id: '', data: token });

            conversationCount++;
            const index = conversationCount;
            let conversation;
            if (conversationStart) {
                //create new conversation
                conversation = {
                    tokens: [{ index, token }],
                    done: false,
                    error: false,
                    result: false,
                    ttl: Math.floor(Date.now() / 1000) + 10 * 60//10 minutes
                }

                conversationStart = false;
            } else {
                conversation = await waitConversationKV(100); //wait for create

                const { tokens } = conversation.props;
                tokens.push({ index, token });
                conversation = { tokens }; //only update tokens
            }

            await conversationKV.set(conversationID, conversation);
        };
    } else {
        onProgress = null;
    }

    let result;
    let error;
    try {
        if (!body.message) {
            const invalidError = new Error();
            invalidError.data = {
                code: 400,
                message: 'The message parameter is required.',
            };
            // noinspection ExceptionCaughtLocallyJS
            throw invalidError;
        }
        const parentMessageId = body.parentMessageId ? body.parentMessageId.toString() : undefined;
        result = await client.sendMessage(body.message, {
            conversationId: body.conversationId ? body.conversationId.toString() : undefined,
            parentMessageId,
            conversationSignature: body.conversationSignature,
            clientId: body.clientId,
            invocationId: body.invocationId,
            onProgress,
        });
    } catch (e) {
        error = e;
    }

    if (result !== undefined) {
        if (settings.apiOptions?.debug) {
            console.debug(result);
        }
        if (body.stream === true) {
            //reply.sse({ event: 'result', id: '', data: JSON.stringify(result) });
            //reply.sse({ id: '', data: '[DONE]' });

            await conversationKV.set(conversationID, { result, done: true });

            await nextTick();
            return reply.raw.end();
        }
        return reply.send(result);
    }

    const code = error?.data?.code || 503;
    if (code === 503) {
        console.error(error);
    } else if (settings.apiOptions?.debug) {
        console.debug(error);
    }
    const message = error?.data?.message || `There was an error communicating with ${clientToUse === 'bing' ? 'Bing' : 'ChatGPT'}.`;
    if (body.stream === true) {
        /*
        reply.sse({
            id: '',
            event: 'error',
            data: JSON.stringify({
                code,
                error: message,
            }),
        });
        */
        await conversationKV.set(conversationID, {
            error: {
                code,
                error: message,
            }
        });

        await nextTick();
        return reply.raw.end();
    }
    return reply.code(code).send({ error: message });
});

server.get('/conversation/:conversationID/:nextID', async (request, reply) => {
    const { conversationID, nextID = 0 } = request.params;

    let conversation = await conversationKV.get(conversationID);
    if (conversation === null) {
        return reply.send({
            id: '',
            event: 'error',
            data: JSON.stringify({
                code: 404,
                error: "conversationID not Found!",
            }),
        });
    }

    let { tokens, done, result, error } = conversation.props;

    if (error) {
        return reply.send({
            id: '',
            event: 'error',
            data: JSON.stringify(error),
        });
    }

    if (done) {
        return reply.send({ event: 'result', id: '', data: JSON.stringify(result) });
        //return reply.send({ id: '', data: '[DONE]' });
    } else {
        let data = '';
        const end = tokens.length;
        tokens = tokens.sort((a, b) => a.index - b.index);
        for (let index = nextID; index < end; index++) {
            data += tokens[index].token;
        }
        return reply.send({ id: end, data });
    }
})

server.listen({
    port: settings.apiOptions?.port || settings.port || 3000,
    host: settings.apiOptions?.host || 'localhost'
}, (error, address) => {
    if (error) {
        console.error(error);
        process.exit(1);
    }
    console.log(`Server is now listening on ${address}`);
});

function nextTick() {
    return new Promise((resolve) => {
        process.nextTick(resolve);
    });
}
