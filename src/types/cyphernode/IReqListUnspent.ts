export interface IReqListUnspent {
  minconf?: number;
  maxconf?: number;
  addresses?: string[];
  queryOptions?: {
    minimumAmount?: number;
    maximumAmount?: number;
    maximumCount?: number;
    minimumSumAmount?: number;
  };
  wallet?: string;
}