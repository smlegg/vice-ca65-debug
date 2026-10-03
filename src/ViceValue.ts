export enum ValueType
{
	Numeric,
	Flags
};

export class ViceValue
{
	value: number;
	bits: number;
	type: ValueType;

	constructor(value: number, bits: number, type: ValueType = ValueType.Numeric)
	{
		this.value = value;
		this.bits = bits;
		this.type = type;
	}

	public toString(): string
	{
		switch (this.type)
		{
			case ValueType.Numeric:
				return `$${this.value.toString(16).padStart(this.bits / 4, '0')} (${this.value.toString()})`;

			case ValueType.Flags:
				return `${this.value & 0x80 ? 'N' : '-'}${this.value & 0x40 ? 'V' : '-'}-${this.value & 0x10 ? 'B' : '-'}${this.value & 0x08 ? 'D' : '-'}${this.value & 0x04 ? 'I' : '-'}${this.value & 0x02 ? 'Z' : '-'}${this.value & 0x01 ? 'C' : '-'}`;
		}
	}

	public toStringWithAddress(address: number)
	{
		return `$${address.toString(16).padStart(4, '0')}: ${this.toString()}`;
	}

	public static fromString(text: string)
	{
		var n = 0;
		if (text.startsWith('$'))
		{
			n = parseInt(text.substring(1));
		} else
		{
			n = parseInt(text);
		}
		return new ViceValue(n, Math.max(8, (Math.round(Math.log2(n) / 8) * 8)));
	}
};

export interface NamedViceValue
{
	name: string;
	value: ViceValue;
}
