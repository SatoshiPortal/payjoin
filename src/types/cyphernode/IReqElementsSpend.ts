// {"address":"AzpmavTHCTfJhUqoS28kg3aTmCzu9uqCdfkqmpCALetAoa3ERpZnHvhNzjMP3wo4XitKEMm62mjFk7B9","amount":0.00233,"confTarget":4,"assetId":"b2e15d0d7a0c94e4e2ce0fe6e8691b9e451377f6e46e8045a86f7c4b5d4f0f23"}
export default interface IReqElementsSpend {
  address: string;
  amount: string;
  confTarget?: number;
  assetId?: string;
}
