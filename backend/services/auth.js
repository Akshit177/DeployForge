const jwt = require('jsonwebtoken');

function getJWTSecert(){
    const secret = proccess.env.JWT_SECRET;
    if(!secret){
        throw new Error("JWT_SECRET is not defined in environment variables");
    }
    return secret;
}

// Creates a token after users logs in successfully
function generateAccessToken(){
    jwt.sign(
        {
            userId : String(userID)
        }, getJWTSeceret(),
        {
            algorithm: "HS256",
            expiresIn: "15m"
        }
    );
}

// Veriy Token Recieved 

function verifyAccessToken(token){
    jwt.verify(toke, getJWTSecert(),{
        algorithms: ["HS256"]
    });

}

module.export ={
    generateAccessToken,
    verifyAccessToken   
};