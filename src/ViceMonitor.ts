import * as vscode from 'vscode';
import { ChildProcess, exec } from 'child_process';
import * as net from 'net';
import * as bin from '@lickle/bin';
import { type Codec } from '@lickle/bin';

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

export class ViceValue
{
	name: string;
	value: number;
	bits: number;

	constructor(name: string, value: number, bits: number)
	{
		this.name = name;
		this.value = value;
		this.bits = bits;
	}

	public toString(): string
	{
		return `$${this.value.toString(16).padStart(this.bits / 4, '0')}`;
	}
};

export class ViceMonitor
{
	process: ChildProcess | null = null;
	client: net.Socket | null = null;
	connected: boolean = false;
	registers: Register[] = [];
	registersByID: { [id: number]: Register } = {};
	registersByName: { [name: string]: Register } = {};
	currentRegisters: { [id: number]: number } = {};
	nextRequestID: number = 1;
	responseCallback: { [requestID: number]: (response: any) => void } = {};
	breakpointCallback?: () => void;

	constructor()
	{
	}

	onBreakpoint(callback: () => void)
	{
		this.breakpointCallback = callback;
	}

	sendCommand(type: number, data: Uint8Array | undefined = undefined, callback: ((data: Buffer<ArrayBuffer>) => void) | undefined = undefined): number
	{
		const packetHeader = bin.encode(CommandPacketHeader, { header: 0x2, apiVersion: 0x2, length: data ? data.length : 0, requestID: this.nextRequestID, commandType: type});
		const packet = new Uint8Array([ ...packetHeader, ...(data ? data : []) ]);

		this.responseCallback[this.nextRequestID] = callback ? callback : () => {};

		this.client?.write(packet);
		return this.nextRequestID++;
	}

	updateCurrentRegisters(data: Buffer<ArrayBuffer>): void
	{
		const body = bin.decode(RegisterResponsePacket, data);
		for (const r of body.registers)
		{
			this.currentRegisters[r.registerID] = r.registerValue;
		}
	}

	connect(callback: () => void)
	{
		this.client = new net.Socket();
		this.client.on('connect', () => {
			this.connected = true;
			console.log("Connected to binary monitor");
			callback();

			this.sendCommand(Command.RegistersAvailable, bin.encode(RegistersAvailableCommandPacket, { memSpace: 0 }), (data: Buffer<ArrayBuffer>) =>
			{
				const response = bin.decode(RegistersAvailableResponsePacket, data);
				for (const r of response.registers)
				{
					const register: Register = { name: r.name, size: r.registerSize, ID: r.registerID };
					this.registers.push(register);
					this.registersByID[register.ID] = register;
					this.registersByName[register.name] = register;
				}
				this.sendCommand(Command.Exit);
			});
		});
		this.client.on('data', (data: Buffer<ArrayBuffer>) => {
			const packetHeader = bin.decode(ResponsePacketHeader, data);

			if (packetHeader.requestID !== 0xffffffff)
			{
				if (packetHeader.requestID in this.responseCallback)
				{
					this.responseCallback[packetHeader.requestID](data.subarray(12));
					delete this.responseCallback[packetHeader.requestID];
				} else
				{
					console.error(`Unexpected response for request ${packetHeader.requestID}, type ${packetHeader.responseType}`);
				}
			} else
			{
				switch (packetHeader.responseType)
				{
					case Response.Register:
						console.log("REGS");
						this.updateCurrentRegisters(data.subarray(12));
						break;

					case Response.Checkpoint:
						this.sendCommand(Command.RegistersGet, bin.encode(RegistersGetCommandPacket, { memSpace: MemorySpace.MainMemory }), (data: Buffer<ArrayBuffer>) =>
						{
							this.updateCurrentRegisters(data);
							if (this.breakpointCallback)
							{
								this.breakpointCallback();
							}
						});
						break;

					default:
						console.error(`Unexpected non-response packet type ${packetHeader.responseType}`);
						break;
				}
			}
		});
		this.client.on('error', (err: Error) => {
			if (!this.connected)
			{
				setTimeout(() =>
				{
					console.log("Retrying connect...");
					this.connect(callback);
				}, 500);
			} else
			{
				console.log(`Error: ${err}`);
			}
		});
		this.client.connect(6510, '127.0.0.1');
	}

	public async start(program: string, callback: () => void)
	{
		const configuration = vscode.workspace.getConfiguration('vice-ca65-debug');
		const cmd = `${configuration.get('viceBinary')} -binarymonitor -binarymonitoraddress 127.0.0.1:6510 -autostart ${program}`;
		this.process = exec(cmd);
		this.connect(callback);
	}

	public stop(callback: () => void)
	{
		this.sendCommand(Command.Quit, undefined, () => callback());
	}

	public pause(callback: () => void)
	{
		this.sendCommand(Command.Ping, undefined, () => callback());
	}

	public resume(callback: () => void)
	{
		this.sendCommand(Command.Exit, undefined, () => callback());
	}

	public step(over: boolean, callback: () => void)
	{
		this.sendCommand(Command.AdvanceInstructions, bin.encode(AdvanceInstructionsCommandPacket, { stepOver: over, numInstructions: 1}), () =>
		{
			this.sendCommand(Command.RegistersGet, bin.encode(RegistersGetCommandPacket, { memSpace: MemorySpace.MainMemory }), (data: Buffer<ArrayBuffer>) =>
			{
				this.updateCurrentRegisters(data);
				callback();
			});
		});
	}

	public untilReturn(callback: () => void)
	{
		this.sendCommand(Command.ExecuteUntilReturn, undefined, () =>
		{
			this.sendCommand(Command.RegistersGet, bin.encode(RegistersGetCommandPacket, { memSpace: MemorySpace.MainMemory }), (data: Buffer<ArrayBuffer>) =>
			{
				this.updateCurrentRegisters(data);
				callback();
			});
		});
	}

	public setBreakpoint(address: number, callback: (breakpointID: number) => void)
	{
		console.log(`SETTING CHECKPOINT AT ${address}`);
		this.sendCommand(Command.CheckpointSet, bin.encode(CheckpointSetCommandPacket,
		{
			startAddress: address,
			endAddress: address,
			stopWhenHit: true,
			enabled: true,
			cpuOperation: CPUOperation.Exec,
			temporary: false,
			memSpace: MemorySpace.MainMemory,
		}), (data: Buffer<ArrayBuffer>) =>
		{
			const response = bin.decode(CheckpointResponsePacket, data);
			console.log(`SET CHECKPOINT ${response.checkpoint} at ${response.startAddress}`);
			callback(response.checkpoint);
		});
	}

	public removeBreakpoint(breakpointID: number)
	{
		this.sendCommand(Command.CheckpointDelete, bin.encode(CheckpointDeleteCommandPacket, { checkpoint: breakpointID }));
	}

	public PC(): number
	{
		if (! ('PC' in this.registersByName))
		{
			return 0;
		} else
		{
			return this.currentRegisters[this.registersByName['PC'].ID];
		}
	}

	public Registers(): ViceValue[]
	{
		var registerValues: ViceValue[] = [];
		for (const r of this.registers)
		{
			if (r.ID in this.currentRegisters)
			{
				registerValues.push(new ViceValue(r.name, this.currentRegisters[r.ID], r.size));
			}
		}
		return registerValues;
	}
};
