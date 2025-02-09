import {Metrics, METRIC_NAMES} from '@ceramicnetwork/metrics'

export function instrumentRequest(req, res, next) {

  const token = req.header("authorization")
  const agent = req.header("user-agent")
  // do some metrics
  // maybe endpoint = req.url or req.originalUrl ?
  Metrics.count(METRIC_NAMES.HTTP_REQUEST, 1,
       {'method': req.method, 'endpoint':req.url, 'agent':agent, 'package':'cli.daemon'})
  next()
}


