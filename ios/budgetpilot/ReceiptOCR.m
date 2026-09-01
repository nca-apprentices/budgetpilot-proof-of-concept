#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE (ReceiptOCR, NSObject)

RCT_EXTERN_METHOD(recognizeText : (NSString *)uri resolver : (RCTPromiseResolveBlock)resolver
                                                            rejecter : (RCTPromiseRejectBlock)rejecter)

@end
