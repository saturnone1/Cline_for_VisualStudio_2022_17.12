type ProtoRecord = Record<string, unknown>

export interface ProtoFactory<TMessage = ProtoRecord> {
	<TValue extends TMessage>(value: TValue): TValue
	create<TValue extends TMessage = TMessage>(value?: TValue): TValue
	fromJson<TValue extends TMessage = TMessage>(value: TValue): TValue
	fromJSON<TValue extends TMessage = TMessage>(value: TValue): TValue
	fromBinary<TValue extends TMessage = TMessage>(value: TValue): TValue
	toJson<TValue extends TMessage = TMessage>(value: TValue): TValue
	toJSON<TValue extends TMessage = TMessage>(value: TValue): TValue
	toBinary<TValue extends TMessage = TMessage>(value: TValue): TValue
	equals(left: unknown, right: unknown): boolean
	[key: string]: unknown
	[key: symbol]: unknown
}

export const createProtoStub = <TMessage = ProtoRecord>(name: string): ProtoFactory<TMessage> => {
	const stubTarget = (<TValue extends TMessage>(value: TValue) => value) as ProtoFactory<TMessage>

	return new Proxy(stubTarget, {
		get: (_target, property) => {
			if (property === "create") {
				return <T extends ProtoRecord>(value: T = {} as T) => value
			}

			if (property === "fromJson" || property === "fromJSON" || property === "fromBinary") {
				return <T>(value: T) => value
			}

			if (property === "toJson" || property === "toJSON" || property === "toBinary") {
				return <T>(value: T) => value
			}

			if (property === "equals") {
				return (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
			}

			if (property === Symbol.toPrimitive) {
				return () => name
			}

			if (property === "toString") {
				return () => name
			}

			if (typeof property === "string") {
				return property
			}

			return undefined
		},
		apply: (_target, _thisArg, [value]: unknown[]) => value,
	})
}
