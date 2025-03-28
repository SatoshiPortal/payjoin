import IReqUnwatchId from './IReqUnwatchId';

export interface IReqUnwatchProps {
  address: string;
  unconfirmedCallbackURL?: string;
  confirmedCallbackURL?: string;
}

export type IReqUnwatch = string | IReqUnwatchId | IReqUnwatchProps;

export default IReqUnwatch;

