import * as vscode from 'vscode';
import { ChildProcess, exec } from 'child_process';
import * as net from 'net';
import * as bin from '@lickle/bin';
import { type Codec } from '@lickle/bin';
import { EventEmitter } from 'events';
import { NamedViceValue, ViceValue, ValueType } from './ViceValue.js';
import * as path from 'path';

enum MemorySpace
{
	MainMemory = 0,
	Drive8,
	Drive9,
	Drive10,
	Drive11

};
enum CPUOperation
{
	Load = 1,
	Store = 2,
	Exec = 4
};

enum ResourceType
{
	String = 0,
	Integer
};

enum Reset
{
	System = 0,
	PowerCycleSystem = 1,
	Drive8 = 8,
	Drive9 = 9,
	Drive10 = 10,
	Drive11 = 11
};

enum Command
{
	MemoryGet = 0x01,
	MemorySet = 0x02,
	CheckpointGet = 0x11,
	CheckpointSet = 0x12,
	CheckpointDelete = 0x13,
	CheckpointList = 0x14,
	CheckpointToggle = 0x15,
	ConditionSet = 0x22,
	RegistersGet = 0x31,
	RegistersSet = 0x32,
	Dump = 0x41,
	Undump = 0x42,
	ResourceGet = 0x51,
	ResourceSet = 0x52,
	AdvanceInstructions = 0x71,
	KeyboardFeed = 0x72,
	ExecuteUntilReturn = 0x73,
	Ping = 0x81,
	BanksAvailable = 0x82,
	RegistersAvailable = 0x83,
	DisplayGet = 0x84,
	VICEInfo = 0x85,
	CPUHistory = 0x86,
	PaletteGet = 0x91,
	JoyportSet = 0xa2,
	UserportSet = 0xb2,
	Exit = 0xaa,
	Quit = 0xbb,
	Reset = 0xcc,
	Autostart = 0xdd
};

enum Response
{
	Invalid = 0,
	Checkpoint = 0x11,
	Register = 0x31,
	JAM = 0x61,
	Stopped = 0x62,
	Resumed = 0x63
};

enum Error
{
	Succeeded = 0,
	NonExistentObject = 1,
	InvalidMemSpace = 2,
	InvalidCommandLength = 0x80,
	InvalidParameter = 0x81,
	InvalidAPIVersion = 0x82,
	InvalidCommand = 0x83,
	InvalidParameterValues = 0x8f
};

const ErrorMessages: { [code: number]: string } =
{
	[Error.Succeeded]: "OK, everything worked.",
	[Error.NonExistentObject]: "The object you are trying to get or set doesn't exist.",
	[Error.InvalidMemSpace]: "The memspace is invalid.",
	[Error.InvalidCommandLength]: "Command length is not correct for this command.",
	[Error.InvalidParameter]: "An invalid parameter value was present.",
	[Error.InvalidAPIVersion]: "The API version is not understood by the server.",
	[Error.InvalidCommand]: "The command type is not understood by the server.",
	[Error.InvalidParameterValues]: "The command had parameter values that passed basic checks, but a general failure occurred."
};

const CommandPacketHeader = bin.struct({
	header: bin.u8(),
	apiVersion: bin.u8(),
	length: bin.u32(true),
	requestID: bin.u32(true),
	commandType: bin.u8()
});

const MemoryGetCommandPacket = bin.struct({
	sideEffects: bin.bool(),
	startAddress: bin.u16(true),
	endAddress: bin.u16(true),
	memSpace: bin.u8(),
	bankID: bin.u16(true)
});

const MemorySetCommandPacket = bin.struct({
	sideEffects: bin.bool(),
	startAddress: bin.u16(true),
	endAddress: bin.u16(true),
	memorySpace: bin.u8(),
	bankID: bin.u16(true)
});

const CheckpointGetCommandPacket = bin.struct({
	checkpoint: bin.u32(true)
});

const CheckpointSetCommandPacket = bin.struct({
	startAddress: bin.u16(true),
	endAddress: bin.u16(true),
	stopWhenHit: bin.bool(),
	enabled: bin.bool(),
	cpuOperation: bin.u8(),
	temporary: bin.bool(),
	memSpace: bin.u8()
});

const CheckpointDeleteCommandPacket = bin.struct({
	checkpoint: bin.u32(true)
});

const CheckpointToggleCommandPacket = bin.struct({
	checkpoint: bin.u32(true),
	enabled: bin.bool()
});

const ConditionSetCommandPacket = bin.struct({
	checkpoint: bin.u32(true),
	expression: bin.utf8({ length: bin.u8()})
});

const RegistersGetCommandPacket = bin.struct({
	memSpace: bin.u8()
});

const RegistersSetCommandPacket = bin.struct({
	memSpace: bin.u8(),
	registers: bin.list(bin.struct({
		itemSize: bin.u8(),
		registerID: bin.u8(),
		registerValue: bin.u16(true)
	}), { length: bin.u16(true) })
});

const DumpCommandPacket = bin.struct({
	saveROMs: bin.bool(),
	saveDisks: bin.bool(),
	fileName: bin.utf8({ length: bin.u8() })
});

const UndumpCommandPacket = bin.struct({
	fileName: bin.utf8({ length: bin.u8() })
});

const ResourceGetCommandPacket = bin.struct({
	name: bin.utf8({ length: bin.u8() })
});

const ResourceSetCommandPacket = bin.struct({
	resourceType: bin.u8(),
	name: bin.utf8({ length: bin.u8() }),
	value: bin.list(bin.u8(), { length: bin.u8() })
});

const AdvanceInstructionsCommandPacket = bin.struct({
	stepOver: bin.bool(),
	numInstructions: bin.u16(true)
});

const KeyboardFeedCommandPacket = bin.struct({
	text: bin.utf8({ length: bin.u8() })
});

const RegistersAvailableCommandPacket = bin.struct({
	memSpace: bin.u8()
});

const DisplayGetCommandPacket = bin.struct({
	useVIC2: bin.bool(),
	format: bin.u8()
});

const CPUHistoryCommandPacket = bin.struct({
	memSpace: bin.u8(),
	count: bin.u32(true)
});

const PaletteGetCommandPacket = bin.struct({
	useVIC2: bin.bool()
});

const JoyportSetCommandPacket = bin.struct({
	port: bin.u16(true),
	value: bin.u16(true)
});

const UserportSetCommandPacket = bin.struct({
	value: bin.u16(true)
});

const ResetCommandPacket = bin.struct({
	reset: bin.u8()
});

const AutostartCommandPacket = bin.struct({
	runAfterLoading: bin.bool(),
	fileIndex: bin.u16(true),
	fileName: bin.utf8({ length: bin.u8() })
});

const ResponsePacketHeader = bin.struct({
	header: bin.u8(),
	apiVersion: bin.u8(),
	length: bin.u32(true),
	responseType: bin.u8(),
	errorCode: bin.u8(),
	requestID: bin.u32(true)
});

const MemoryGetResponsePacket = bin.struct({
	memory: bin.list(bin.u8(), { length: bin.u16(true)})
});

const CheckpointResponsePacket = bin.struct({
	checkpoint: bin.u32(true),
	currentlyHit: bin.bool(),
	startAddress: bin.u16(true),
	endAddress: bin.u16(true),
	stopWhenHit: bin.bool(),
	enabled: bin.bool(),
	cpuOperation: bin.u8(),
	temporary: bin.bool(),
	hitCount: bin.u32(true),
	ignoreCount: bin.u32(true),
	hasCondition: bin.bool(),
	memSpace: bin.u8()
});

const UndumpResponsePacket = bin.struct({
	pc: bin.u16(true)
});

const ResourceGetResponsePacket = bin.struct({
	resourceType: bin.u8(),
	resourceValue: bin.list(bin.u8(), { length: bin.u8() })
});

const BanksAvailableResponsePacket = bin.struct({
	banks: bin.list(bin.struct({
		itemSize: bin.u8(),
		bankID: bin.u16(true),
		name: bin.utf8({ length: bin.u8() })
	}), { length: bin.u16(true) })
});

const RegistersAvailableResponsePacket = bin.struct({
	registers: bin.list(bin.struct({
		itemSize: bin.u8(),
		registerID: bin.u8(),
		registerSize: bin.u8(),
		name: bin.utf8({ length: bin.u8() })
	}), { length: bin.u16(true) })
});

const DisplayGetResponsePacket = bin.struct({
	fieldLength: bin.u32(true),
	debugWidth: bin.u16(true),
	debugHeight: bin.u16(true),
	xOffset: bin.u16(true),
	yOffset: bin.u16(true),
	innerWidth: bin.u16(true),
	innerHeight: bin.u16(true),
	bitsPerPixel: bin.u8(),
	displayBuffer: bin.list(bin.u8(), { length: bin.u32(true) })
});

const VICEInfoResponsePacket = bin.struct({
	mainVersion: bin.list(bin.u8(), { length: bin.u8() }),
	svnVersion: bin.list(bin.u8(), { length: bin.u8() }),
});

const CPUHistoryResponsePacket = bin.struct({
	history: bin.list(bin.struct({
		itemSize: bin.u8(),
		registers: bin.list(bin.struct({
			itemSize: bin.u8(),
			registerID: bin.u8(),
			registerValue: bin.u16(true)
		}), { length: bin.u16(true) }),
		cpuClock: bin.u64(true),
		instruction: bin.list(bin.u16(), { length: bin.u8() })
	}), { length: bin.u32(true) })
});

const PaletteGetResponsePacket = bin.struct({
	palette: bin.list(bin.struct({
		itemSize: bin.u8(),
		red: bin.u8(),
		green: bin.u8(),
		blue: bin.u8(),
	}), { length: bin.u16(true) })
});

const RegisterResponsePacket = bin.struct({
	registers: bin.list(bin.struct({
		itemSize: bin.u8(),
		registerID: bin.u8(),
		registerValue: bin.u16(true)
	}), { length: bin.u16(true) })
});

interface Register
{
	name: string;
	size: number;
	ID: number;
};

export class ViceMonitor extends EventEmitter
{
	process: ChildProcess | null = null;
	client: net.Socket | null = null;
	connected: boolean = false;
	running: boolean = false;
	allRegisters: Register[] = [];
	registersByID: { [id: number]: Register } = {};
	registersByName: { [name: string]: Register } = {};
	currentRegisters: { [id: number]: number } = {};
	nextRequestID: number = 1;
	responseCallback: { [requestID: number]: (packetHeader: any, data: Buffer<ArrayBuffer>) => void } = {};
	currentHeader?: Codec.Decoded<typeof ResponsePacketHeader>;
	dataIn?: Buffer<ArrayBuffer>;

	constructor()
	{
		super();
	}

	async sendCommand(type: number, data: Uint8Array | undefined = undefined): Promise<Buffer<ArrayBuffer>>
	{
		const packetHeader = bin.encode(CommandPacketHeader, { header: 0x2, apiVersion: 0x2, length: data ? data.length : 0, requestID: this.nextRequestID, commandType: type});
		const packet = new Uint8Array([ ...packetHeader, ...(data ? data : []) ]);
		const requestID = this.nextRequestID++;

		return new Promise<Buffer<ArrayBuffer>>((resolve: (data: Buffer<ArrayBuffer>) => void, reject: (reason: any) => void) =>
		{
			this.responseCallback[requestID] = (packetHeader: any, data: Buffer<ArrayBuffer>) =>
			{
				if (packetHeader.errorCode === 0)
				{
					resolve(data);
				} else
				{
					const msg = (packetHeader.errorCode in ErrorMessages) ? ErrorMessages[packetHeader.errorCode] : `error code ${packetHeader.errorCode}`;
					reject(msg);
				}
			};
			this.client?.write(packet);
		});
	}

	updateCurrentRegisters(data: Buffer<ArrayBuffer>): void
	{
		const body = bin.decode(RegisterResponsePacket, data);
		//console.log(`UPDATEREGS: ${JSON.stringify(body)}`);
		for (const r of body.registers)
		{
			this.currentRegisters[r.registerID] = r.registerValue;
		}
	}

	async connect(resolve: () => void): Promise<void>
	{
		this.client = new net.Socket();
		this.client.on('connect', async () => {
			this.connected = true;
			this.running = true;
			console.info("Connected to binary monitor");

			const responseData = await this.sendCommand(Command.RegistersAvailable, bin.encode(RegistersAvailableCommandPacket, { memSpace: 0 }));

			//console.log("Got registers available response");

			const response = bin.decode(RegistersAvailableResponsePacket, responseData);
			for (const r of response.registers)
			{
				const register: Register = { name: r.name, size: r.registerSize, ID: r.registerID };
				this.allRegisters.push(register);
				this.registersByID[register.ID] = register;
				this.registersByName[register.name] = register;
			}
			await this.sendCommand(Command.Exit);

			//console.log("Resolving connect");

			resolve();
		});
		this.client.on('data', async (data: Buffer<ArrayBuffer>) => {

			//console.log(`RECEIVED ${data.length} BYTES (CURRENT: ${this.dataIn?.length})`);

			if (this.dataIn && this.dataIn.length)
			{
				this.dataIn = Buffer.concat([this.dataIn, data]);
			} else
			{
				this.dataIn = data;
			}

			while (true)
			{
				if (!this.currentHeader)
				{
					if (this.dataIn.length < 12)
					{
						break;
					}

					this.currentHeader = bin.decode(ResponsePacketHeader, this.dataIn);
					this.dataIn = this.dataIn.subarray(12);
				}

				if (!this.currentHeader || this.dataIn.length < this.currentHeader.length)
				{
					break;
				}

				//console.log(`REQUEST ${this.currentHeader.requestID} TYPE ${this.currentHeader.responseType} LENGTH ${this.currentHeader.length} (HAVE ${this.dataIn.length})`);

				const header = this.currentHeader;
				this.currentHeader = undefined;

				const packetData = this.dataIn.subarray(0, header.length);
				this.dataIn = this.dataIn.subarray(header.length);

				//console.log(`NOW HAVE ${this.dataIn.length}`);

				if (header.requestID !== 0xffffffff)
				{
					if (header.requestID in this.responseCallback)
					{
						//console.log(`HAVE HANDLER`);

						this.responseCallback[header.requestID](header, packetData);
						delete this.responseCallback[header.requestID];
					} else
					{
						console.error(`Unexpected response for request ${header.requestID}, type ${header.responseType}`);
					}
				} else
				{
					//console.log(`NO HANDLER`);

					switch (header.responseType)
					{
						case Response.Register:
							//console.log("REGS");
							this.updateCurrentRegisters(packetData);
							break;

						case Response.Checkpoint:
						{
							//console.log(`CHECKPOINT`);

							const registerData = await this.sendCommand(Command.RegistersGet, bin.encode(RegistersGetCommandPacket, { memSpace: MemorySpace.MainMemory }));
							this.updateCurrentRegisters(registerData);
							this.emit('breakpoint');
							break;
						}

						case Response.Stopped:
							this.running = false;
							this.emit('stopped');
							break;

						case Response.Resumed:
							this.running = true;
							this.emit('resumed');
							break;

						default:
							console.error(`Unexpected non-response packet type ${header.responseType}`);
							break;
					}
				}
			}
		});
		this.client.on('error', (err: Error) => {
			if (!this.connected)
			{
				setTimeout(() =>
				{
					//console.log("Retrying connect...");
					this.client?.connect(6510, '127.0.0.1');
				}, 500);
			} else
			{
				console.error(`Error: ${err}`);
			}
		});
		this.client.connect(6510, '127.0.0.1');
	}

	public async start(program: string)
	{
		const configuration = vscode.workspace.getConfiguration('vice-ca65-debug');
		const cmd = `${configuration.get('viceBinary')} -binarymonitor -binarymonitoraddress 127.0.0.1:6510 -autostart ${program}`;
		this.process = exec(cmd, { cwd: path.dirname(program) });
		this.process.on('close', () =>
		{
			this.emit('terminated');
		});

		return new Promise<void>((resolve: () => void, reject: (reason:any) => void) =>
		{
			this.connect(resolve);
		});
	}

	public async restart(program: string)
	{
		await this.sendCommand(Command.Autostart, bin.encode(AutostartCommandPacket, { runAfterLoading: true, fileIndex: 0, fileName: program }));
	}

	public async stop()
	{
		await this.sendCommand(Command.Quit);
	}

	public async pause()
	{
		await this.sendCommand(Command.Ping);
	}

	public async resume()
	{
		await this.sendCommand(Command.Exit);
	}

	public async step(over: boolean)
	{
		await this.sendCommand(Command.AdvanceInstructions, bin.encode(AdvanceInstructionsCommandPacket, { stepOver: over, numInstructions: 1}));
	}

	public async untilReturn()
	{
		await this.sendCommand(Command.ExecuteUntilReturn);
	}

	public async setBreakpoint(address: number, size: number, type: 'read' | 'write' | 'readWrite' | 'exec', condition: string | undefined = undefined): Promise<number | undefined>
	{
		//console.log(`SETTING CHECKPOINT AT ${address}`);

		let cpuOperation = CPUOperation.Exec;
		switch (type)
		{
			case 'read': cpuOperation = CPUOperation.Load; break;
			case 'write': cpuOperation = CPUOperation.Store; break;
			case 'readWrite': cpuOperation = CPUOperation.Load | CPUOperation.Store; break;
			case 'exec': cpuOperation = CPUOperation.Exec; break;
		}

		const responseData = await this.sendCommand(Command.CheckpointSet, bin.encode(CheckpointSetCommandPacket,
		{
			startAddress: address,
			endAddress: address + size - 1,
			stopWhenHit: true,
			enabled: true,
			cpuOperation: cpuOperation,
			temporary: false,
			memSpace: MemorySpace.MainMemory,
		}));
		const response = bin.decode(CheckpointResponsePacket, responseData);
		if (condition)
		{
			try
			{
				await this.sendCommand(Command.ConditionSet, bin.encode(ConditionSetCommandPacket, { checkpoint: response.checkpoint, expression: condition }));
			} catch (error)
			{
				console.error(`failed to set condition: ${error}`);

				await this.removeBreakpoint(response.checkpoint);
				return undefined;
			}
		}

		//console.log(`SET CHECKPOINT ${response.checkpoint} at ${response.startAddress}`);
		return response.checkpoint;
	}

	public async removeBreakpoint(breakpointID: number)
	{
		await this.sendCommand(Command.CheckpointDelete, bin.encode(CheckpointDeleteCommandPacket, { checkpoint: breakpointID }));
	}

	public pc(): number
	{
		if (! ('PC' in this.registersByName))
		{
			return 0;
		} else
		{
			return this.currentRegisters[this.registersByName['PC'].ID];
		}
	}

	public registers(): NamedViceValue[]
	{
		var registerValues: NamedViceValue[] = [];
		for (const r of this.allRegisters)
		{
			if (r.ID in this.currentRegisters)
			{
				registerValues.push({ name: r.name, value: new ViceValue(this.currentRegisters[r.ID], r.size, r.name === "FL" ? ValueType.Flags : ValueType.Numeric) });
			}
		}
		return registerValues;
	}

	public register(name: string): ViceValue | undefined
	{
		if (!(name in this.registersByName))
		{
			return undefined;
		}

		const reg = this.registersByName[name];
		return new ViceValue(this.currentRegisters[reg.ID], reg.size, reg.name === "FL" ? ValueType.Flags : ValueType.Numeric);
	}

	public async setRegister(name: string, value: number)
	{
		if (name in this.registersByName)
		{
			const reg = this.registersByName[name];
			await this.sendCommand(Command.RegistersSet, bin.encode(RegistersSetCommandPacket, { memSpace: MemorySpace.MainMemory, registers: [ { itemSize: 3, registerID: reg.ID, registerValue: value }]}));
			const registerData= await this.sendCommand(Command.RegistersGet, bin.encode(RegistersGetCommandPacket, { memSpace: MemorySpace.MainMemory }));
			this.updateCurrentRegisters(registerData);
		}
	}

	public isRunning(): boolean
	{
		return this.running;
	}

	public async readMemory(address: number, size: number): Promise<number[]>
	{
		const responseData = await this.sendCommand(Command.MemoryGet, bin.encode(MemoryGetCommandPacket, { sideEffects: false, startAddress: address, endAddress: address + size - 1, memSpace: MemorySpace.MainMemory, bankID: 0 }));
		const response = bin.decode(MemoryGetResponsePacket, responseData);
		return response.memory;
	}

	public async writeMemory(address: number, data: number[])
	{
		const packet = bin.encode(MemorySetCommandPacket, { sideEffects: false, startAddress: address, endAddress: address + data.length - 1, memorySpace: MemorySpace.MainMemory, bankID: 0 });
		const packetData = new Uint8Array(data);
		const packetWithData = Buffer.concat([ packet, packetData ]);
		await this.sendCommand(Command.MemorySet, packetWithData);
	}
};
